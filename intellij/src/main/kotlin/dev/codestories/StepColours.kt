package dev.codestories

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.highlighter.EditorHighlighterFactory
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.awt.Font
import java.nio.file.Path

/**
 * Colours the code of the open step with the IDE's own syntax highlighter and colour scheme, and
 * adds the result to the panel state as `hl`. A span is [text, colour or null, style]; style is
 * 1 for italic and 2 for bold. When anything fails, the state goes out without `hl` and the panel
 * colours the code itself.
 */
object StepColours {
    fun add(project: Project, message: JsonObject) {
        try {
            // The lexers read IDE state, so the whole pass is one read action.
            ReadAction.run<RuntimeException> { colourStep(project, message) }
        } catch (_: Exception) {
        }
    }

    private fun colourStep(project: Project, message: JsonObject) {
        run {
            val state = message.getAsJsonObject("state") ?: return
            state.remove("hl")
            if (state.get("view")?.asString != "story") {
                return
            }
            val storyIndex = state.get("storyIndex").asInt
            val stepIndex = state.get("stepIndex").asInt
            val step = state.getAsJsonObject("doc").getAsJsonArray("stories")[storyIndex].asJsonObject
                .getAsJsonArray("steps")[stepIndex].asJsonObject
            val file = step.get("file").asString
            val removed = step.get("removed")?.asBoolean == true
            val type = FileTypeManager.getInstance().getFileTypeByFileName(file.replace('\\', '/').substringAfterLast('/'))
            val base = project.basePath ?: return
            val lines = step.getAsJsonArray("lines")
            val last = lines.maxOfOrNull { number(it.asJsonObject, "line") ?: 0 } ?: 0

            // The file as the IDE has it, with changes that are not saved yet.
            val inFile: List<String> = if (removed || last == 0) emptyList() else ReadAction.compute<List<String>, RuntimeException> {
                val virtual = LocalFileSystem.getInstance().findFileByNioFile(Path.of(base, file))
                val text = virtual?.let { FileDocumentManager.getInstance().getDocument(it)?.text }
                text?.split("\n")?.take(last) ?: emptyList()
            }
            val fromFile = if (inFile.isEmpty()) emptyList() else colour(project, type, inFile.joinToString("\n"))

            val out = JsonArray()
            for (element in lines) {
                val line = element.asJsonObject
                val text = line.get("text")?.asString ?: ""
                val no = number(line, "line")
                val original = if (no != null && no <= inFile.size) inFile[no - 1] else null
                val moved = if (original != null && original.trim() == text.trim()) reindent(fromFile[no!! - 1], original, text) else null
                // A removed line, or a line that no longer matches the file: colour it by itself.
                out.add(moved ?: colour(project, type, text).firstOrNull() ?: JsonArray())
            }
            state.add("hl", JsonObject().apply {
                addProperty("story", storyIndex)
                addProperty("step", stepIndex)
                add("lines", out)
            })
        }
    }

    private fun number(line: JsonObject, key: String): Int? {
        val value = line.get(key)
        return if (value == null || value.isJsonNull) null else value.asInt
    }

    private fun span(text: String, colour: String?, style: Int) = JsonArray().apply {
        add(text)
        if (colour == null) add(JsonNull.INSTANCE) else add(colour)
        add(style)
    }

    /** The text as lines of spans, coloured by the lexer of the file type and the editor's colour scheme. */
    private fun colour(project: Project, type: FileType, text: String): List<JsonArray> {
        val scheme = EditorColorsManager.getInstance().globalScheme
        val plain = scheme.defaultForeground
        val highlighter = EditorHighlighterFactory.getInstance().createEditorHighlighter(project, type)
        highlighter.setColorScheme(scheme)
        highlighter.setText(text)
        val lines = ArrayList<JsonArray>()
        var current = JsonArray()
        val tokens = highlighter.createIterator(0)
        while (!tokens.atEnd()) {
            val attributes = tokens.textAttributes
            val foreground = attributes?.foregroundColor
            // Text in the scheme's plain colour stays uncoloured: the panel has its own text colour.
            val colour = if (foreground == null || foreground == plain) null else "#%02x%02x%02x".format(foreground.red, foreground.green, foreground.blue)
            val font = attributes?.fontType ?: Font.PLAIN
            val style = (if (font and Font.ITALIC != 0) 1 else 0) or (if (font and Font.BOLD != 0) 2 else 0)
            for ((n, piece) in text.substring(tokens.start, tokens.end).split("\n").withIndex()) {
                if (n > 0) {
                    lines.add(current)
                    current = JsonArray()
                }
                if (piece.isNotEmpty()) {
                    current.add(span(piece, colour, style))
                }
            }
            tokens.advance()
        }
        lines.add(current)
        return lines
    }

    /** The colours of a file line, moved onto the story's copy of it, which can have other indentation. */
    private fun reindent(spans: JsonArray, inFile: String, text: String): JsonArray? {
        val lead = inFile.length - inFile.trimStart().length
        val out = JsonArray()
        val body = StringBuilder()
        var at = 0
        for (element in spans) {
            val s = element.asJsonArray
            val piece = s[0].asString
            val from = maxOf(at, lead)
            val end = at + piece.length
            at = end
            if (end > from) {
                val part = inFile.substring(from, end)
                body.append(part)
                out.add(span(part, if (s[1].isJsonNull) null else s[1].asString, s[2].asInt))
            }
        }
        if (body.toString().trimEnd() != text.trim()) {
            return null
        }
        val indent = text.substring(0, text.length - text.trimStart().length)
        if (indent.isEmpty()) {
            return out
        }
        return JsonArray().apply {
            add(span(indent, null, 0))
            addAll(out)
        }
    }
}
