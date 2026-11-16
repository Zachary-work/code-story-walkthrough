package dev.codestories

import com.google.gson.JsonObject
import com.intellij.notification.Notification
import com.intellij.notification.NotificationsManager
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.wm.WindowManager
import com.intellij.ui.jcef.JBCefBrowser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.awt.Component
import java.awt.Window
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO

/**
 * A scripted run through the plugin inside a real IDE, for checking it without a person at the
 * keyboard. It does nothing unless the environment variable CODE_STORIES_SELFTEST names a folder.
 * Then, once a project opens, it opens the story panel, runs the commands in script.txt in that
 * folder (or a built-in script), writes what it finds there, and closes the IDE.
 *
 *   gradlew runIde -PselfTest=<folder> --args="<project with .stories>"
 *
 * Pictures are drawn from the IDE's own windows. The screen is never read, so no other
 * application can appear in them, and the IDE is not brought to the front.
 *
 * Script commands, one per line:
 *   wait <ms>            click <css selector>      shot <name.png>     dump <name.txt>
 *   hide <tool window>   quiet (close notifications)                   editor <label>
 *   comment <file> <start> <end> <text>            size <width> <height>   widen <px>
 */
object SelfTest {
    val dir: File? = System.getenv("CODE_STORIES_SELFTEST")?.takeIf { it.isNotBlank() }?.let(::File)
    val BROWSER = Key.create<JBCefBrowser>("codeStories.selfTest.browser")

    private val builtIn = """
        dump overview.txt
        shot 1-overview.png
        click [data-tab="lines"]
        dump lines.txt
        click [data-tab="stories"]
        click [data-a="story"][data-i="0"]
        dump story.txt
        editor after opening story 1
        shot 2-story.png
        click [data-a="move"][data-d="1"]
        editor after next step
        click [data-a="diff"]
        editor after open diff
        click [data-a="file"]
        editor after open file
    """.trimIndent()

    /** Messages the page sends for the test are written to files instead of going to the core. */
    fun intercept(message: JsonObject): Boolean {
        if (dir == null || message.get("type")?.asString != "selftest") {
            return false
        }
        File(dir, message.get("name").asString).writeText(message.get("text").asString)
        return true
    }

    suspend fun run(project: Project) {
        val out = dir ?: return
        out.mkdirs()
        val log = StringBuilder()
        fun note(line: String) {
            log.appendLine(line)
            File(out, "log.txt").writeText(log.toString())
        }
        suspend fun <T> ui(block: () -> T): T = withContext(Dispatchers.EDT) { block() }
        suspend fun js(code: String) = ui {
            val browser = project.getUserData(BROWSER) ?: error("the story panel has no browser")
            browser.cefBrowser.executeJavaScript(code, browser.cefBrowser.url, 0)
        }
        fun draw(component: Component, file: File) {
            if (component.width <= 0 || component.height <= 0) {
                return
            }
            val image = BufferedImage(component.width, component.height, BufferedImage.TYPE_INT_RGB)
            val g = image.createGraphics()
            try {
                component.paint(g)
            } finally {
                g.dispose()
            }
            ImageIO.write(image, "png", file)
        }
        suspend fun command(line: String) {
            val name = line.substringBefore(' ')
            val arg = line.substringAfter(' ', "").trim()
            when (name) {
                "wait" -> delay(arg.toLong())
                "click" -> {
                    val selector = arg.replace("\\", "\\\\").replace("'", "\\'")
                    js("(function () { var el = document.querySelector('$selector'); acquireVsCodeApi().postMessage({ type: 'selftest', name: 'click.txt', text: (el ? 'clicked ' : 'NOT FOUND ') + '$selector' }); if (el) el.click(); })();")
                    delay(1500)
                    note(File(out, "click.txt").takeIf { it.exists() }?.readText() ?: "no click report for $arg")
                }
                "dump" -> {
                    js("acquireVsCodeApi().postMessage({ type: 'selftest', name: '$arg', text: document.body.innerText });")
                    delay(500)
                }
                // The main window, and any other window of the IDE that is open (such as a comment thread).
                "shot" -> ui {
                    val frame = WindowManager.getInstance().getFrame(project) ?: return@ui
                    draw(frame.rootPane, File(out, arg))
                    Window.getWindows().filter { it.isShowing && it !== frame && it.width > 40 && it.height > 40 }.forEachIndexed { i, window ->
                        draw(window, File(out, arg.removeSuffix(".png") + "-window${i + 1}.png"))
                    }
                }
                "size" -> ui {
                    val (w, h) = arg.split(' ').map { it.toInt() }
                    WindowManager.getInstance().getFrame(project)?.setSize(w, h)
                }
                "widen" -> ui { (ToolWindowManager.getInstance(project).getToolWindow("Code Stories") as? com.intellij.openapi.wm.ex.ToolWindowEx)?.stretchWidth(arg.toInt()) }
                "hide" -> ui { ToolWindowManager.getInstance(project).getToolWindow(arg)?.hide() }
                "quiet" -> ui {
                    NotificationsManager.getNotificationsManager().getNotificationsOfType(Notification::class.java, project).forEach { it.expire() }
                }
                "editor" -> ui {
                    val manager = FileEditorManager.getInstance(project)
                    val text = manager.selectedTextEditor
                    val file = text?.let { FileDocumentManager.getInstance().getFile(it.document) }
                    val marks = text?.markupModel?.allHighlighters ?: emptyArray()
                    note(
                        "$arg: tab=${manager.selectedEditor?.javaClass?.simpleName} file=${file?.name} line=${text?.caretModel?.logicalPosition?.line?.plus(1)} " +
                            "lineMarks=${marks.count { it.getTextAttributes(null)?.backgroundColor != null }} gutterIcons=${marks.count { it.gutterIconRenderer != null }} " +
                            "hints=${text?.inlayModel?.getAfterLineEndElementsInRange(0, text.document.textLength)?.size}"
                    )
                }
                "comment" -> {
                    val parts = arg.split(' ', limit = 4)
                    Core.of(project).send("comment") {
                        addProperty("op", "add"); addProperty("file", parts[0]); addProperty("startLine", parts[1].toInt())
                        addProperty("endLine", parts[2].toInt()); addProperty("body", parts[3]); addProperty("source", "local")
                    }
                    delay(1500)
                    note("threads=${Core.of(project).last("comments")?.getAsJsonArray("threads")?.size()}")
                }
                else -> note("unknown command: $line")
            }
        }
        try {
            delay(4000)
            note("problem=${Core.of(project).problem}")
            ui { ToolWindowManager.getInstance(project).getToolWindow("Code Stories")?.activate(null) ?: error("no Code Stories tool window") }
            delay(6000)
            note("state=${Core.of(project).last("state") != null} problem=${Core.of(project).problem}")
            val script = File(out, "script.txt").takeIf { it.exists() }?.readText() ?: builtIn
            for (line in script.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }) {
                command(line)
            }
            note("FINISHED")
        } catch (e: Throwable) {
            note("FAILED ${e.javaClass.simpleName}: ${e.message}\n${e.stackTraceToString().lines().take(12).joinToString("\n")}")
        } finally {
            File(out, "done.txt").writeText("done")
            ApplicationManager.getApplication().invokeLater { ApplicationManager.getApplication().exit(true, true, false) }
        }
    }
}
