package dev.codestories

import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.editor.EditorFactory
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
import java.awt.image.BufferedImage
import java.io.File
import javax.imageio.ImageIO

/**
 * A scripted run through the plugin inside a real IDE, for checking it without a person at the
 * keyboard. It does nothing unless the environment variable CODE_STORIES_SELFTEST names a folder;
 * then, once a project opens, it clicks through the panel, records what the panel and the editor
 * show into that folder, saves pictures of the IDE window (drawn from its own components, never
 * captured from the screen), and closes the IDE.
 *
 *   gradlew runIde -PselfTest=<output folder> --args="<project with .stories>"
 */
object SelfTest {
    val dir: File? = System.getenv("CODE_STORIES_SELFTEST")?.takeIf { it.isNotBlank() }?.let(::File)
    val BROWSER = Key.create<JBCefBrowser>("codeStories.selfTest.browser")

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
        suspend fun dump(name: String) {
            js("acquireVsCodeApi().postMessage({ type: 'selftest', name: '$name', text: document.body.innerText });")
            delay(500)
        }
        suspend fun click(selector: String) {
            js("(function () { var el = document.querySelector('$selector'); acquireVsCodeApi().postMessage({ type: 'selftest', name: 'click.txt', text: (el ? 'clicked ' : 'NOT FOUND ') + '$selector' }); if (el) el.click(); })();")
            delay(1500)
            note(File(out, "click.txt").takeIf { it.exists() }?.readText() ?: "no click report for $selector")
        }
        suspend fun editor(label: String) = ui {
            val manager = FileEditorManager.getInstance(project)
            val text = manager.selectedTextEditor
            val file = text?.let { FileDocumentManager.getInstance().getFile(it.document) }
            val marks = text?.markupModel?.allHighlighters ?: emptyArray()
            note(
                "$label: tab=${manager.selectedEditor?.javaClass?.simpleName} file=${file?.name} line=${text?.caretModel?.logicalPosition?.line?.plus(1)} " +
                    "lineMarks=${marks.count { it.getTextAttributes(null)?.backgroundColor != null }} gutterIcons=${marks.count { it.gutterIconRenderer != null }} " +
                    "hints=${text?.inlayModel?.getAfterLineEndElementsInRange(0, text.document.textLength)?.size}"
            )
        }
        // Draws the IDE window's own components into an image. It never reads the screen, so it
        // cannot capture other applications, and it does not bring the IDE to the front.
        suspend fun shot(name: String) = ui {
            val pane = WindowManager.getInstance().getFrame(project)?.rootPane ?: return@ui
            if (pane.width <= 0 || pane.height <= 0) {
                return@ui
            }
            val image = BufferedImage(pane.width, pane.height, BufferedImage.TYPE_INT_RGB)
            val g = image.createGraphics()
            try {
                pane.paint(g)
            } finally {
                g.dispose()
            }
            ImageIO.write(image, "png", File(out, name))
        }
        try {
            delay(4000)
            note("problem=${Core.of(project).problem}")
            ui { ToolWindowManager.getInstance(project).getToolWindow("Code Stories")?.activate(null) ?: error("no Code Stories tool window") }
            delay(6000)
            note("state=${Core.of(project).last("state") != null} problem=${Core.of(project).problem}")
            dump("overview.txt")
            shot("1-overview.png")

            click("[data-tab=\"lines\"]")
            dump("lines.txt")
            shot("2-lines.png")
            click("[data-tab=\"stories\"]")

            click("[data-a=\"story\"][data-i=\"0\"]")
            dump("story.txt")
            editor("after opening story 1")
            shot("3-story.png")

            click("[data-a=\"move\"][data-d=\"1\"]")
            editor("after next step")
            click("#step-2")
            editor("after the removed step")
            shot("4-removed.png")

            click("#step-0")
            click("[data-a=\"diff\"]")
            editor("after open diff")
            shot("5-diff.png")

            // A comment, added the way the comment window adds one, then its thread opened.
            click("[data-a=\"file\"]")
            editor("after open file")
            Core.of(project).send("comment") {
                addProperty("op", "add"); addProperty("file", "src/calc.js"); addProperty("startLine", 8)
                addProperty("endLine", 10); addProperty("body", "Why refuse a negative total instead of clamping it to zero?"); addProperty("source", "local")
            }
            delay(2000)
            editor("after adding a comment")
            val thread = Core.of(project).last("comments")?.getAsJsonArray("threads")?.firstOrNull()?.asJsonObject
            note("threads=${Core.of(project).last("comments")?.getAsJsonArray("threads")?.size()}")
            if (thread != null) {
                ui {
                    val target = EditorFactory.getInstance().allEditors.firstOrNull {
                        it.project == project && FileDocumentManager.getInstance().getFile(it.document)?.name == "calc.js"
                    } ?: error("calc.js is not open")
                    CommentGutter.of(project).show(target, thread.get("id").asString)
                }
                delay(1500)
                shot("6-comment.png")
            }
            click("[data-tab=\"comments\"]")
            dump("comments.txt")
            note("FINISHED")
        } catch (e: Throwable) {
            note("FAILED ${e.javaClass.simpleName}: ${e.message}\n${e.stackTraceToString().lines().take(12).joinToString("\n")}")
        } finally {
            File(out, "done.txt").writeText("done")
            ApplicationManager.getApplication().invokeLater { ApplicationManager.getApplication().exit(true, true, false) }
        }
    }
}
