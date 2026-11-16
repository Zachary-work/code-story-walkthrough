package dev.codestories

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Key
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Review threads in the editor gutter. IntelliJ has no ready-made comment threads, so each thread
 * is a gutter icon that opens a small window with the messages, a reply box and a resolve button.
 * The comments themselves are kept by the core, in comments.json.
 */
@Service(Service.Level.PROJECT)
class CommentGutter(private val project: Project) : Disposable {
    private val core get() = Core.of(project)
    private var threads = JsonArray()
    var prLinked = false
        private set
    private var started = false

    fun start() {
        if (started) {
            return
        }
        started = true
        core.listen(this) { m ->
            if (m.get("type").asString == "comments") {
                threads = m.getAsJsonArray("threads") ?: JsonArray()
                prLinked = m.get("prLinked")?.asBoolean == true
                EditorFactory.getInstance().allEditors.forEach { draw(it) }
            }
        }
    }

    /** Puts an icon in the gutter of this editor for every thread on its file. */
    fun draw(editor: Editor) {
        if (editor.project != project) {
            return
        }
        editor.getUserData(ICONS)?.forEach { editor.markupModel.removeHighlighter(it) }
        val file = FileDocumentManager.getInstance().getFile(editor.document)?.takeIf { it.isInLocalFileSystem }
        val path = file?.let { EditorBridge.of(project).relative(it) }
        val icons = ArrayList<RangeHighlighter>()
        for (thread in threads) {
            val t = thread.asJsonObject
            val line = t.get("startLine").asInt - 1
            if (t.get("file").asString != path || line < 0 || line >= editor.document.lineCount) {
                continue
            }
            val highlighter = editor.markupModel.addLineHighlighter(line, HighlighterLayer.LAST, null)
            highlighter.gutterIconRenderer = ThreadIcon(t.get("id").asString, t.get("label").asString) { show(editor, it) }
            icons.add(highlighter)
        }
        editor.putUserData(ICONS, icons)
    }

    /** Opens the window for one thread, below its first line. */
    fun show(editor: Editor, id: String) {
        val thread = threads.map { it.asJsonObject }.firstOrNull { it.get("id").asString == id } ?: return
        lateinit var popup: JBPopup
        val reply = JBTextArea(3, 40).apply { lineWrap = true; wrapStyleWord = true; emptyText.text = "Reply" }
        val messages = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS); border = JBUI.Borders.empty(0, 0, 8, 0) }
        for (message in thread.getAsJsonArray("messages")) {
            val m = message.asJsonObject
            messages.add(JBLabel("<html><b>${escape(m.get("author").asString)}</b></html>").apply { alignmentX = 0f })
            messages.add(JBTextArea(m.get("text").asString).apply {
                isEditable = false; lineWrap = true; wrapStyleWord = true; isOpaque = false; alignmentX = 0f
                border = JBUI.Borders.empty(2, 0, 8, 0)
            })
        }
        val buttons = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0))
        buttons.add(JButton("Resolve").apply {
            addActionListener {
                core.send("comment") { addProperty("op", "resolve"); addProperty("id", id) }
                popup.cancel()
            }
        })
        buttons.add(JButton("Reply").apply {
            addActionListener {
                if (reply.text.isNotBlank()) {
                    core.send("comment") { addProperty("op", "reply"); addProperty("id", id); addProperty("body", reply.text) }
                    popup.cancel()
                }
            }
        })
        val panel = JPanel(BorderLayout(0, 8)).apply {
            border = JBUI.Borders.empty(12)
            add(JBLabel(thread.get("label").asString).apply { foreground = JBUI.CurrentTheme.ContextHelp.FOREGROUND }, BorderLayout.NORTH)
            add(JBScrollPane(messages).apply { border = JBUI.Borders.empty(); preferredSize = Dimension(JBUI.scale(460), JBUI.scale(180)) }, BorderLayout.CENTER)
            add(JPanel(BorderLayout(0, 8)).apply {
                add(JBScrollPane(reply), BorderLayout.CENTER)
                add(buttons, BorderLayout.SOUTH)
            }, BorderLayout.SOUTH)
        }
        popup = popup(panel, reply, "Review Comment")
        place(popup, editor)
    }

    /** Asks for a new comment on the lines selected in this editor. */
    fun compose(editor: Editor) {
        val file = FileDocumentManager.getInstance().getFile(editor.document)?.takeIf { it.isInLocalFileSystem }
        val path = file?.let { EditorBridge.of(project).relative(it) }
        if (path == null || path.startsWith(".stories/")) {
            EditorBridge.of(project).notify("warning", "Review comments go on files in this project.")
            return
        }
        val document = editor.document
        val selection = editor.selectionModel
        val start = document.getLineNumber(selection.selectionStart) + 1
        var end = document.getLineNumber(selection.selectionEnd) + 1
        // A selection that ends at the start of a line does not include that line.
        if (end > start && selection.selectionEnd == document.getLineStartOffset(end - 1)) {
            end--
        }
        lateinit var popup: JBPopup
        val body = JBTextArea(4, 40).apply { lineWrap = true; wrapStyleWord = true; emptyText.text = "What should change here, or what is unclear?" }
        val add = { source: String ->
            if (body.text.isNotBlank()) {
                core.send("comment") {
                    addProperty("op", "add"); addProperty("file", path); addProperty("startLine", start)
                    addProperty("endLine", end); addProperty("body", body.text); addProperty("source", source)
                }
                popup.cancel()
            }
        }
        val buttons = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0))
        buttons.add(JButton("Comment on PR").apply {
            isEnabled = prLinked
            toolTipText = if (prLinked) "Posts a review comment to the linked pull request" else "Link a pull request in the story panel first"
            addActionListener { add("pr") }
        })
        buttons.add(JButton("Comment locally").apply {
            toolTipText = "Saves the comment for your agent"
            addActionListener { add("local") }
        })
        val where = if (start == end) "line $start" else "lines $start to $end"
        val panel = JPanel(BorderLayout(0, 8)).apply {
            border = JBUI.Borders.empty(12)
            add(JBLabel("${path.substringAfterLast('/')}, $where").apply { foreground = JBUI.CurrentTheme.ContextHelp.FOREGROUND }, BorderLayout.NORTH)
            add(JBScrollPane(body), BorderLayout.CENTER)
            add(buttons, BorderLayout.SOUTH)
        }
        popup = popup(panel, body, "Add Review Comment")
        place(popup, editor)
    }

    private fun popup(panel: JComponent, focus: JComponent, title: String): JBPopup =
        JBPopupFactory.getInstance().createComponentPopupBuilder(panel, focus)
            .setTitle(title).setRequestFocus(true).setFocusable(true).setMovable(true).setResizable(true)
            .setCancelOnClickOutside(true).setCancelOnWindowDeactivation(false)
            .createPopup()

    /** Next to the caret when the editor is on screen, otherwise in the middle of the window. */
    private fun place(popup: JBPopup, editor: Editor) {
        if (editor.contentComponent.isShowing) {
            popup.showInBestPositionFor(editor)
        } else {
            popup.showCenteredInCurrentWindow(project)
        }
    }

    private fun escape(text: String) = text.replace("&", "&amp;").replace("<", "&lt;")

    private class ThreadIcon(private val id: String, private val label: String, private val open: (String) -> Unit) : GutterIconRenderer() {
        override fun getIcon(): Icon = AllIcons.General.Balloon
        override fun getTooltipText(): String = label
        override fun isNavigateAction(): Boolean = true
        override fun getClickAction(): AnAction = object : AnAction() {
            override fun actionPerformed(e: AnActionEvent) = open(id)
        }
        override fun equals(other: Any?): Boolean = other is ThreadIcon && other.id == id && other.label == label
        override fun hashCode(): Int = id.hashCode()
    }

    override fun dispose() {}

    companion object {
        private val ICONS = Key.create<List<RangeHighlighter>>("codeStories.threads")
        fun of(project: Project): CommentGutter = project.getService(CommentGutter::class.java)
    }
}
