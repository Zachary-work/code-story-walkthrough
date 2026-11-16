package dev.codestories

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefClient
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color
import java.nio.file.Files
import javax.swing.JComponent
import javax.swing.SwingConstants
import javax.swing.UIManager

/**
 * The story panel: the same web page the VS Code extension shows (media/panel.js and panel.css),
 * hosted in a tool window. The page thinks it is talking to VS Code; a small shim routes its
 * messages to the core, and the core's state goes back in as the page expects.
 */
class StoriesToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance().createContent(build(project, toolWindow), "", false)
        toolWindow.contentManager.addContent(content)
    }

    private fun build(project: Project, toolWindow: ToolWindow): JComponent {
        if (!JBCefApp.isSupported()) {
            return message("The story panel needs the IDE's built-in browser (JCEF), which is not available in this IDE or this session.")
        }
        val core = Core.of(project)
        EditorBridge.of(project).start()
        core.problem?.let { return message(it) }

        val browser = JBCefBrowser()
        Disposer.register(toolWindow.disposable, browser)
        // Lets the bridge be created whether or not the native browser already exists.
        browser.jbCefClient.setProperty(JBCefClient.Properties.JS_QUERY_POOL_SIZE, 4)
        val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
        Disposer.register(browser, query)
        query.addHandler { raw ->
            try {
                val message = JsonParser.parseString(raw)
                if (!(message.isJsonObject && SelfTest.intercept(message.asJsonObject))) {
                    core.send("panel") { add("message", message) }
                }
            } catch (_: Exception) {
            }
            null
        }
        project.putUserData(SelfTest.BROWSER, browser)
        val load = { browser.loadHTML(page(core, query)) }
        core.listen(browser) { m ->
            if (m.get("type").asString == "state") {
                StepColours.add(project, m)
                post(browser, m)
            }
        }
        ApplicationManager.getApplication().messageBus.connect(browser).subscribe(LafManagerListener.TOPIC, LafManagerListener { load() })
        load()
        return browser.component
    }

    private fun message(text: String): JComponent =
        JBLabel("<html><div style='padding:16px'>${text.replace("&", "&amp;").replace("<", "&lt;")}</div></html>", SwingConstants.CENTER)

    private fun post(browser: JBCefBrowser, state: JsonObject) {
        browser.cefBrowser.executeJavaScript("window.postMessage($state, '*');", browser.cefBrowser.url, 0)
    }

    private fun page(core: Core, query: JBCefJSQuery): String {
        val media = core.pluginDir.resolve("media")
        val css = Files.readString(media.resolve("panel.css"))
        val js = Files.readString(media.resolve("panel.js"))
        // The page asks for acquireVsCodeApi(); in this IDE that is a bridge to the plugin.
        val shim = "window.acquireVsCodeApi = function () { return { postMessage: function (m) { ${query.inject("JSON.stringify(m)")} } }; };"
        return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${theme()}</style>
<style>$css</style>
<title>Stories</title>
</head>
<body>
<div id="root"></div>
<script>$shim</script>
<script>$js</script>
</body>
</html>"""
    }

    /** The IDE's colours and fonts, under the variable names the shared stylesheet reads. */
    private fun theme(): String {
        val dark = !JBColor.isBright()
        val scheme = EditorColorsManager.getInstance().globalScheme
        fun hex(c: Color?, fallback: String) = if (c == null) fallback else "#%02x%02x%02x".format(c.red, c.green, c.blue)
        fun ui(key: String, fallback: String) = hex(UIManager.getColor(key), fallback)
        val font = UIUtil.getLabelFont()
        val vars = linkedMapOf(
            "foreground" to hex(UIUtil.getLabelForeground(), if (dark) "#dfe1e5" else "#000000"),
            "editor-background" to hex(UIUtil.getPanelBackground(), if (dark) "#2b2d30" else "#f7f8fa"),
            "sideBar-background" to hex(scheme.defaultBackground, if (dark) "#1e1f22" else "#ffffff"),
            "descriptionForeground" to hex(UIUtil.getContextHelpForeground(), if (dark) "#9da0a8" else "#6c707e"),
            "widget-border" to hex(JBColor.border(), if (dark) "#43454a" else "#d3d5db"),
            "focusBorder" to hex(JBUI.CurrentTheme.Focus.focusColor(), "#3574f0"),
            "button-background" to ui("Button.default.startBackground", "#3574f0"),
            "button-hoverBackground" to ui("Button.default.endBackground", "#3574f0"),
            "button-foreground" to ui("Button.default.foreground", "#ffffff"),
            "textLink-foreground" to hex(JBUI.CurrentTheme.Link.Foreground.ENABLED, if (dark) "#548af7" else "#2470b3"),
            "input-foreground" to ui("TextField.foreground", if (dark) "#dfe1e5" else "#000000"),
            "input-background" to ui("TextField.background", if (dark) "#2b2d30" else "#ffffff"),
            "list-hoverBackground" to if (dark) "rgba(255,255,255,0.06)" else "rgba(0,0,0,0.05)",
            "list-inactiveSelectionBackground" to if (dark) "rgba(53,116,240,0.18)" else "rgba(53,116,240,0.10)",
            "toolbar-hoverBackground" to if (dark) "rgba(255,255,255,0.08)" else "rgba(0,0,0,0.06)",
            "textCodeBlock-background" to hex(scheme.defaultBackground, if (dark) "#1e1f22" else "#ffffff"),
            "editorLineNumber-foreground" to if (dark) "#6f737a" else "#8c8f99",
            "diffEditor-insertedLineBackground" to if (dark) "rgba(73,156,84,0.25)" else "rgba(73,156,84,0.18)",
            "diffEditor-removedLineBackground" to if (dark) "rgba(219,92,92,0.25)" else "rgba(219,92,92,0.16)",
            "editor-findMatchHighlightBackground" to if (dark) "rgba(214,174,88,0.28)" else "rgba(245,200,90,0.35)",
            "inputValidation-warningBackground" to if (dark) "rgba(214,145,60,0.22)" else "rgba(245,180,90,0.25)",
            "inputValidation-errorBackground" to if (dark) "rgba(219,92,92,0.22)" else "rgba(219,92,92,0.14)",
            "charts-orange" to if (dark) "#e0984f" else "#a85d00",
            "charts-green" to if (dark) "#6aab73" else "#2e7d32",
            "charts-red" to if (dark) "#e06c6c" else "#c62828",
            "charts-yellow" to if (dark) "#d6ae58" else "#9a7500",
            "font-family" to "'${font.family}', system-ui, sans-serif",
            "font-size" to "${font.size}px",
            "editor-font-family" to "'${scheme.editorFontName}', ui-monospace, monospace",
            "editor-font-size" to "${scheme.editorFontSize}px"
        )
        // The colours of the editor's own syntax highlighting, for the code in a step.
        fun token(key: TextAttributesKey, fallback: String) = hex(scheme.getAttributes(key)?.foregroundColor, fallback)
        val tokens = linkedMapOf(
            "kw" to token(DefaultLanguageHighlighterColors.KEYWORD, if (dark) "#cf8e6d" else "#0033b3"),
            "str" to token(DefaultLanguageHighlighterColors.STRING, if (dark) "#6aab73" else "#067d17"),
            "com" to token(DefaultLanguageHighlighterColors.LINE_COMMENT, if (dark) "#7a7e85" else "#8c8c8c"),
            "num" to token(DefaultLanguageHighlighterColors.NUMBER, if (dark) "#2aacb8" else "#1750eb"),
            "fn" to token(DefaultLanguageHighlighterColors.FUNCTION_DECLARATION, if (dark) "#56a8f5" else "#00627a"),
            "type" to token(DefaultLanguageHighlighterColors.CLASS_NAME, "inherit"),
            "meta" to token(DefaultLanguageHighlighterColors.METADATA, if (dark) "#b3ae60" else "#9e880d")
        )
        return ":root { color-scheme: ${if (dark) "dark" else "light"}; " + vars.entries.joinToString(" ") { "--vscode-${it.key}: ${it.value};" } +
            " " + tokens.entries.joinToString(" ") { "--tok-${it.key}: ${it.value};" } + " }"
    }
}
