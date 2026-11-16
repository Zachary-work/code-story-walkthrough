package dev.codestories

import com.google.gson.JsonObject
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.util.DiffUserDataKeys
import com.intellij.diff.util.Side
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileDocumentManagerListener
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.Pair
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.IdeFrame
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.JBColor
import com.intellij.util.Alarm
import java.awt.Color
import java.awt.Graphics
import java.awt.Rectangle
import java.awt.datatransfer.StringSelection
import java.io.File

/**
 * Keeps the editor in step with the stories: opens files and diffs the core asks for, marks the
 * changed and calling lines of the open story, and tells the core when files are saved.
 */
@Service(Service.Level.PROJECT)
class EditorBridge(private val project: Project) : Disposable {
    private val core get() = Core.of(project)
    private var started = false
    private var marks: JsonObject = JsonObject()
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)

    /** The workspace-relative path of a file, with forward slashes, or null when it is outside the project. */
    fun relative(file: VirtualFile): String? {
        val root = project.basePath?.replace('\\', '/')?.trimEnd('/') ?: return null
        val path = file.path
        return if (path.startsWith("$root/")) path.substring(root.length + 1) else null
    }

    fun find(relative: String): VirtualFile? {
        val root = project.basePath ?: return null
        return LocalFileSystem.getInstance().refreshAndFindFileByIoFile(File(root, relative))
    }

    @Synchronized
    fun start() {
        if (started) {
            core.start()
            return
        }
        started = true
        core.listen(this) { handle(it) }
        CommentGutter.of(project).start()
        val bus = ApplicationManager.getApplication().messageBus.connect(this)
        // The core re-reads git when something may have changed on disk.
        bus.subscribe(FileDocumentManagerListener.TOPIC, object : FileDocumentManagerListener {
            override fun beforeAllDocumentsSaving() = changedSoon()
            override fun beforeDocumentSaving(document: com.intellij.openapi.editor.Document) = changedSoon()
        })
        bus.subscribe(ApplicationActivationListener.TOPIC, object : ApplicationActivationListener {
            override fun applicationActivated(ideFrame: IdeFrame) = changedSoon()
        })
        EditorFactory.getInstance().addEditorFactoryListener(object : EditorFactoryListener {
            override fun editorCreated(event: EditorFactoryEvent) {
                decorate(event.editor)
                CommentGutter.of(project).draw(event.editor)
            }
        }, this)
        core.start()
    }

    private fun changedSoon() {
        alarm.cancelAllRequests()
        alarm.addRequest({ core.send("event") { addProperty("name", "saved") } }, 400)
    }

    private fun handle(m: JsonObject) {
        when (m.get("type").asString) {
            "navigate" -> navigate(m)
            "decorate" -> {
                marks = m.getAsJsonObject("files") ?: JsonObject()
                EditorFactory.getInstance().allEditors.forEach { decorate(it) }
            }
            "effect" -> effect(m)
        }
    }

    // --- navigation ---------------------------------------------------------------------------------

    private fun open(file: VirtualFile, line: Int, focus: Boolean = false): Editor? =
        FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, file, maxOf(0, line - 1), 0), focus)

    private fun navigate(m: JsonObject) {
        val file = m.get("file").asString
        val line = m.get("line").asInt
        if (m.get("removed")?.asBoolean == true) {
            val text = m.get("baseText")?.takeIf { !it.isJsonNull }?.asString
            if (text == null) {
                notify("warning", "$file was removed, and its earlier version could not be read from git.")
                return
            }
            val name = File(file).name
            val shown = LightVirtualFile("$name (removed, as on ${m.get("base")?.asString ?: "base"})", FileTypeManager.getInstance().getFileTypeByFileName(name), text)
            shown.isWritable = false
            open(shown, line)
            return
        }
        val target = find(file)
        if (target == null) {
            notify("warning", "$file could not be opened.")
            return
        }
        open(target, line)
    }

    // --- marks in the editor --------------------------------------------------------------------------

    private fun decorate(editor: Editor) {
        if (editor.project != project) {
            return
        }
        editor.getUserData(MARKS)?.forEach { editor.markupModel.removeHighlighter(it) }
        editor.getUserData(HINTS)?.forEach { it.dispose() }
        val file = FileDocumentManager.getInstance().getFile(editor.document)
        val entries = file?.takeIf { it.isInLocalFileSystem }?.let { relative(it) }?.let { marks.getAsJsonArray(it) }
        val highlighters = ArrayList<RangeHighlighter>()
        val hints = ArrayList<Inlay<*>>()
        entries?.forEach { entry ->
            val e = entry.asJsonObject
            val line = e.get("line").asInt - 1
            if (line < 0 || line >= editor.document.lineCount) {
                return@forEach
            }
            val call = e.get("kind").asString == "call"
            val attributes = TextAttributes().apply { backgroundColor = if (call) CALL else ADDED }
            highlighters.add(editor.markupModel.addLineHighlighter(line, HighlighterLayer.SELECTION - (if (call) 1 else 2), attributes))
            val hint = e.get("hint")?.takeIf { !it.isJsonNull }?.asString
            if (call && hint != null) {
                editor.inlayModel.addAfterLineEndElement(editor.document.getLineEndOffset(line), false, HintRenderer(hint))?.let { hints.add(it) }
            }
        }
        editor.putUserData(MARKS, highlighters)
        editor.putUserData(HINTS, hints)
    }

    private class HintRenderer(private val text: String) : EditorCustomElementRenderer {
        override fun calcWidthInPixels(inlay: Inlay<*>): Int {
            val editor = inlay.editor
            return editor.contentComponent.getFontMetrics(editor.colorsScheme.getFont(EditorFontType.ITALIC)).stringWidth("    $text")
        }

        override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
            val editor = inlay.editor
            g.font = editor.colorsScheme.getFont(EditorFontType.ITALIC)
            g.color = JBColor.GRAY
            g.drawString("    $text", targetRegion.x, targetRegion.y + editor.ascent)
        }
    }

    // --- things the panel asks for --------------------------------------------------------------------

    private fun effect(m: JsonObject) {
        when (m.get("name").asString) {
            "openDiff" -> openDiff(m)
            "openFile" -> find(m.get("file").asString)?.let { open(it, m.get("line").asInt) } ?: notify("warning", "${m.get("file").asString} could not be opened.")
            "copy" -> CopyPasteManager.getInstance().setContents(StringSelection(m.get("text").asString))
            "message" -> notify(m.get("level").asString, m.get("text").asString)
            "confirmDeleteSet" -> {
                val title = m.get("title").asString
                val answer = Messages.showYesNoDialog(
                    project,
                    "This deletes ${m.get("folder").asString}: its stories and its review comments. It cannot be undone.",
                    "Delete the Story Set \"$title\"?",
                    "Delete", "Cancel", Messages.getWarningIcon()
                )
                if (answer == Messages.YES) {
                    core.send("command") { addProperty("name", "deleteSet"); addProperty("id", m.get("id").asString) }
                }
            }
            "askInstallSkill" -> {
                val options = arrayOf("This project, for Claude Code (.claude/skills)", "This project, for other agents (.agents/skills)", "All my projects, for Claude Code (~/.claude/skills)")
                val pick = Messages.showChooseDialog(project, "Where should the code-stories agent skill go? An existing copy there is replaced.", "Install Agent Skill", null, options, options[0])
                if (pick >= 0) {
                    core.send("command") { addProperty("name", "installSkill"); addProperty("where", arrayOf("claude", "agents", "home")[pick]) }
                }
            }
            "askLinkPr" -> {
                val url = Messages.showInputDialog(project, "Pull request link, like https://github.com/owner/repo/pull/123", "Link a Pull Request", null)
                if (!url.isNullOrBlank()) {
                    core.send("command") { addProperty("name", "linkPr"); addProperty("url", url) }
                }
            }
            "openComment" -> {
                val file = find(m.get("file").asString) ?: return
                val editor = open(file, m.get("startLine").asInt, focus = true) ?: return
                CommentGutter.of(project).show(editor, m.get("id").asString)
            }
        }
    }

    private fun openDiff(m: JsonObject) {
        val path = m.get("file").asString
        val name = File(path).name
        val type = FileTypeManager.getInstance().getFileTypeByFileName(name)
        val base = m.get("baseText")?.takeIf { !it.isJsonNull }?.asString
        val baseName = m.get("base")?.asString?.ifBlank { null } ?: "base"
        val factory = DiffContentFactory.getInstance()
        val current = if (m.get("exists").asBoolean) find(path) else null
        val before = factory.create(project, base ?: "", type)
        val after = if (current != null) factory.create(project, current) else factory.create(project, "", type)
        val request = SimpleDiffRequest(
            "$name ($baseName ↔ working tree)", before, after,
            if (base == null) "Not in $baseName" else baseName,
            if (current == null) "Removed" else "Working tree"
        )
        request.putUserData(DiffUserDataKeys.SCROLL_TO_LINE, Pair.create(Side.RIGHT, maxOf(0, m.get("line").asInt - 1)))
        DiffManager.getInstance().showDiff(project, request)
    }

    fun notify(level: String, text: String) {
        val type = when (level) {
            "error" -> NotificationType.ERROR
            "warning" -> NotificationType.WARNING
            else -> NotificationType.INFORMATION
        }
        NotificationGroupManager.getInstance().getNotificationGroup("Code Stories").createNotification(text, type).notify(project)
    }

    override fun dispose() {}

    companion object {
        private val MARKS = Key.create<List<RangeHighlighter>>("codeStories.marks")
        private val HINTS = Key.create<List<Inlay<*>>>("codeStories.hints")
        private val ADDED = JBColor(Color(0xDD, 0xF4, 0xE0), Color(0x2B, 0x45, 0x30))
        private val CALL = JBColor(Color(0xFF, 0xF1, 0xBF), Color(0x4A, 0x43, 0x22))

        fun of(project: Project): EditorBridge = project.getService(EditorBridge::class.java)
    }
}
