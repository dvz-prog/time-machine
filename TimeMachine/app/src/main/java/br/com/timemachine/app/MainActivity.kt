package br.com.timemachine.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Time machine para Android.
 *
 * Carrega a mesma interface da extensão (assets/app.html) dentro de um WebView e substitui
 * o que a extensão fazia por recursos do Android:
 *  - regras de rede (remover X-Frame-Options/CSP, bloquear capturas fora de 2025-2026)
 *    -> shouldInterceptRequest
 *  - chrome.downloads / downloads de blob -> DownloadManager / MediaStore (ponte AndroidBridge)
 *  - chrome.tabs.captureVisibleTab -> PixelCopy
 *  - remoção de telas de login (content script) -> script injetado no HTML das capturas
 */
class MainActivity : Activity() {

    private val appHost = "appassets.androidplatform.net"
    private val wayback = "web.archive.org"

    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private lateinit var loader: WebViewAssetLoader

    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    private val rxDoc = Regex("^/web/\\d+if_/")
    private val rxAsset = Regex("^/web/\\d+id_/")
    // Mesma regra do rules.json da extensão: bloqueia quadros de capturas fora de 2025-2026
    private val rxBlocked = Regex(
        "^https://web\\.archive\\.org/web/(1[0-9]{3}|20[0-1][0-9]|202[0-4]|202[7-9]|20[3-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})"
    )
    private val rxHead = Regex("<head(\\s[^>]*)?>", RegexOption.IGNORE_CASE)
    private val rxHtml = Regex("<html(\\s[^>]*)?>", RegexOption.IGNORE_CASE)
    private val rxCharset = Regex("charset=([^;\\s]+)", RegexOption.IGNORE_CASE)

    /** unlock.js como <script> ASCII puro, para ser injetado dentro do HTML das capturas. */
    private val injectTag: String by lazy {
        val raw = assets.open("unlock.js").bufferedReader().use { it.readText() }
        val sb = StringBuilder("<script>")
        for (ch in raw) {
            if (ch.code < 128) sb.append(ch) else sb.append(String.format("\\u%04x", ch.code))
        }
        sb.append("</script>").toString()
    }

    // ------------------------------------------------------------------ ciclo de vida

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        loader = WebViewAssetLoader.Builder()
            .setDomain(appHost)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            fitsSystemWindows = true
        }
        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        root.addView(
            web,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
        setContentView(root)

        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW

        setupBridge()
        web.webViewClient = client
        web.webChromeClient = chrome
        web.loadUrl(startUrl(intent))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        web.loadUrl(startUrl(intent))
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
    override fun onBackPressed() {
        if (customView != null) {
            chrome.onHideCustomView()
            return
        }
        val js = "(function(){var v=document.getElementById('viewer'),l=document.getElementById('lightbox')," +
            "p=document.getElementById('shotPop');" +
            "if((v&&!v.hidden)||(l&&!l.hidden)||(p&&!p.hidden)){" +
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return 1}return 0})()"
        web.evaluateJavascript(js) { r -> if (r != "1") moveTaskToBack(true) }
    }

    private fun startUrl(i: Intent?): String {
        val base = "https://$appHost/assets/app.html"
        if (i?.action == Intent.ACTION_SEND) {
            val text = i.getStringExtra(Intent.EXTRA_TEXT) ?: ""
            val m = Regex("https?://\\S+").find(text)
            if (m != null) return base + "?url=" + Uri.encode(m.value)
        }
        return base
    }

    // ------------------------------------------------------------------ WebView

    private val client = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            val host = uri.host ?: return null
            if (host == appHost) return loader.shouldInterceptRequest(uri)
            if (host == wayback && request.method == "GET") {
                val p = uri.path ?: ""
                val isDoc = rxDoc.containsMatchIn(p)
                if (isDoc || rxAsset.containsMatchIn(p) || p.startsWith("/cdx/") || p.startsWith("/save/")) {
                    return proxy(request, isDoc)
                }
            }
            return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val u = request.url
            if (u.host == appHost) return false
            if (request.isForMainFrame) {
                // links "Abrir no Wayback" etc. vão para o navegador do celular
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, u))
                } catch (_: Exception) {
                }
                return true
            }
            return false
        }
    }

    private val chrome = object : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customCallback = callback
            (window.decorView as FrameLayout).addView(
                view,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            )
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }

        override fun onHideCustomView() {
            val v = customView ?: return
            (window.decorView as FrameLayout).removeView(v)
            customView = null
            customCallback?.onCustomViewHidden()
            customCallback = null
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    // ------------------------------------------------------------------ rede (substitui rules.json)

    private fun blank(): WebResourceResponse =
        WebResourceResponse("text/html", "utf-8", 200, "OK", HashMap(), ByteArrayInputStream(ByteArray(0)))

    /**
     * Baixa a requisição do Wayback por conta própria para:
     *  - remover X-Frame-Options / Content-Security-Policy (permite o quadro da captura);
     *  - acrescentar CORS para o app (consulta CDX, fotos e vídeos);
     *  - bloquear quadros de capturas fora de 2025-2026;
     *  - injetar o unlock.js (remoção de telas de login) no HTML dos quadros.
     */
    private fun proxy(request: WebResourceRequest, isDoc: Boolean): WebResourceResponse? {
        try {
            var url = request.url.toString()
            var hops = 0
            var redirected = false
            lateinit var conn: HttpURLConnection
            while (true) {
                if (isDoc && rxBlocked.containsMatchIn(url)) return blank()
                conn = URL(url).openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 20000
                conn.readTimeout = 60000
                for ((k, v) in request.requestHeaders) {
                    when (k.lowercase()) {
                        "range", "accept", "accept-language", "user-agent" -> conn.setRequestProperty(k, v)
                    }
                }
                val code = conn.responseCode
                if (code in 300..399 && code != 304) {
                    val loc = conn.getHeaderField("Location")
                    conn.disconnect()
                    hops++
                    if (loc == null || hops > 8) return null
                    url = URL(URL(url), loc).toString()
                    if (!url.startsWith("https://")) return null
                    redirected = true
                    continue
                }
                break
            }

            val code = conn.responseCode
            val stream = if (code >= 400) {
                conn.errorStream ?: ByteArrayInputStream(ByteArray(0))
            } else {
                conn.inputStream
            }
            val ctype = conn.contentType ?: "application/octet-stream"
            val mime = ctype.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
            val charset = rxCharset.find(ctype)?.groupValues?.get(1)?.trim('"', '\'')

            val headers = HashMap<String, String>()
            for ((k, v) in conn.headerFields) {
                if (k == null || v.isNullOrEmpty()) continue
                val lk = k.lowercase()
                if (lk.startsWith("access-control-")) continue
                when (lk) {
                    "x-frame-options", "content-security-policy", "content-security-policy-report-only",
                    "content-type", "content-encoding", "content-length", "transfer-encoding",
                    "connection", "set-cookie", "location", "keep-alive" -> {}
                    else -> headers[k] = v.joinToString(", ")
                }
            }
            if (redirected && headers.keys.none { it.equals("content-location", true) }) {
                headers["Content-Location"] = url   // o app descobre o carimbo de data pelo endereço final
            }
            headers["Access-Control-Allow-Origin"] = "https://$appHost"
            headers["Access-Control-Allow-Credentials"] = "true"
            headers["Access-Control-Expose-Headers"] = "Content-Location, Content-Range, Content-Type"

            var body: java.io.InputStream = stream
            if (isDoc && code == 200 && mime.equals("text/html", true)) {
                val html = String(stream.readBytes(), Charsets.ISO_8859_1)
                stream.close()
                val m = rxHead.find(html) ?: rxHtml.find(html)
                val out = if (m != null) {
                    val at = m.range.last + 1
                    html.substring(0, at) + injectTag + html.substring(at)
                } else {
                    injectTag + html
                }
                body = ByteArrayInputStream(out.toByteArray(Charsets.ISO_8859_1))
            }

            val status = if (code in 100..599 && code !in 300..399) code else 200
            val reason = conn.responseMessage?.takeIf { it.isNotBlank() } ?: "OK"
            return WebResourceResponse(mime, charset, status, reason, headers, body)
        } catch (e: Exception) {
            return null   // se falhar, o WebView tenta carregar normalmente
        }
    }

    // ------------------------------------------------------------------ ponte JS <-> Android

    private fun setupBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Toast.makeText(this, "Atualize o Android System WebView para usar downloads e prints.", Toast.LENGTH_LONG).show()
            return
        }
        // Só a página do próprio app (não as capturas do Wayback) pode falar com esta ponte.
        WebViewCompat.addWebMessageListener(
            web, "AndroidBridge", setOf("https://$appHost"),
            object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(
                    view: WebView,
                    message: WebMessageCompat,
                    sourceOrigin: Uri,
                    isMainFrame: Boolean,
                    replyProxy: JavaScriptReplyProxy
                ) {
                    if (!isMainFrame) return
                    handleBridge(message.data ?: return, replyProxy)
                }
            }
        )
    }

    private fun handleBridge(raw: String, reply: JavaScriptReplyProxy) {
        val o = try { JSONObject(raw) } catch (e: Exception) { return }
        val id = o.optInt("id")

        fun send(ok: Boolean, error: String? = null, data: String? = null) {
            val r = JSONObject()
            r.put("id", id)
            r.put("ok", ok)
            if (error != null) r.put("error", error)
            if (data != null) r.put("data", data)
            runOnUiThread { reply.postMessage(r.toString()) }
        }

        when (o.optString("op")) {
            "download" -> {
                try {
                    val url = o.getString("url")
                    val name = o.optString("name", "arquivo").ifBlank { "arquivo" }
                    if (!url.startsWith("https://web.archive.org/")) {
                        send(false, "Endereço não permitido.")
                        return
                    }
                    val req = DownloadManager.Request(Uri.parse(url))
                        .setTitle(name)
                        .setDescription("Time machine")
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                        .addRequestHeader("User-Agent", web.settings.userAgentString)
                    (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                    Toast.makeText(this, "Baixando: $name (pasta Downloads)", Toast.LENGTH_SHORT).show()
                    send(true)
                } catch (e: Exception) {
                    send(false, e.message ?: "Falha ao iniciar o download.")
                }
            }

            "saveBase64" -> {
                val name = o.optString("name", "arquivo").ifBlank { "arquivo" }
                val mime = o.optString("mime", "application/octet-stream").ifBlank { "application/octet-stream" }
                val data = o.optString("data")
                Thread {
                    try {
                        val bytes = Base64.decode(data, Base64.DEFAULT)
                        saveToDownloads(name, mime, bytes)
                        runOnUiThread {
                            Toast.makeText(this, "Salvo em Downloads: $name", Toast.LENGTH_SHORT).show()
                        }
                        send(true)
                    } catch (e: Exception) {
                        send(false, e.message ?: "Falha ao salvar o arquivo.")
                    }
                }.start()
            }

            "capture" -> capture { dataUrl ->
                if (dataUrl != null) send(true, data = dataUrl) else send(false, "Não foi possível capturar a tela.")
            }

            else -> send(false, "Operação desconhecida.")
        }
    }

    private fun saveToDownloads(name: String, mime: String, bytes: ByteArray) {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("Não foi possível criar o arquivo em Downloads.")
        contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            ?: throw IllegalStateException("Não foi possível gravar o arquivo.")
    }

    /** Captura a área do WebView (inclui o quadro da página arquivada) como PNG em data URL. */
    private fun capture(done: (String?) -> Unit) {
        val w = web.width
        val h = web.height
        if (w <= 0 || h <= 0) {
            done(null)
            return
        }
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val loc = IntArray(2)
        web.getLocationInWindow(loc)
        val rect = Rect(loc[0], loc[1], loc[0] + w, loc[1] + h)
        try {
            PixelCopy.request(window, rect, bmp, { result ->
                if (result == PixelCopy.SUCCESS) {
                    Thread { done(encodePng(bmp)) }.start()
                } else {
                    done(null)
                }
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            done(null)
        }
    }

    private fun encodePng(bmp: Bitmap): String {
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        bmp.recycle()
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}
