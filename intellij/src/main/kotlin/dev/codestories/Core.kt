package dev.codestories

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.SystemInfo
import java.io.BufferedWriter
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The shared review logic, running as a Node process (out/core/server.js). This class starts it,
 * sends it one JSON message per line and hands each line it writes to whoever is listening.
 * Everything the plugin knows about stories comes through here.
 */
@Service(Service.Level.PROJECT)
class Core(private val project: Project) : Disposable {
    private val log = logger<Core>()
    private val listeners = CopyOnWriteArrayList<(JsonObject) -> Unit>()
    private var process: Process? = null
    private var writer: BufferedWriter? = null

    /** Why the core is not running, in words for the user. Null while it runs. */
    @Volatile
    var problem: String? = null
        private set

    /** The last message of each type, so a panel or editor that opens late can catch up. */
    private val latest = HashMap<String, JsonObject>()

    val pluginDir: Path
        get() = PluginManagerCore.getPlugin(PluginId.getId("dev.codestories.walkthrough"))!!.pluginPath

    /** Listens to every message from the core. Called on the UI thread. */
    fun listen(parent: Disposable, handler: (JsonObject) -> Unit) {
        listeners.add(handler)
        com.intellij.openapi.util.Disposer.register(parent) { listeners.remove(handler) }
    }

    fun last(type: String): JsonObject? = synchronized(latest) { latest[type] }

    @Synchronized
    fun start() {
        if (process?.isAlive == true) {
            return
        }
        val root = project.basePath
        if (root == null) {
            problem = "Open a project folder to use Code Stories."
            return
        }
        val node = PathEnvironmentVariableUtil.findInPath(if (SystemInfo.isWindows) "node.exe" else "node")
        if (node == null) {
            problem = "Node.js was not found on your PATH. Code Stories runs its review logic with Node. Install it from nodejs.org, then restart the IDE."
            return
        }
        val server = pluginDir.resolve("core").resolve("server.js").toFile()
        if (!server.exists()) {
            problem = "This plugin is missing its core files (${server.path}). Reinstall it."
            return
        }
        val state = File(PathManager.getSystemPath(), "code-stories/${project.locationHash}.json")
        try {
            val started = GeneralCommandLine(
                node.path, server.path,
                "--root", root,
                "--state", state.path,
                "--skill", pluginDir.resolve("skill").resolve("code-stories").toString()
            ).withWorkDirectory(root).withCharset(StandardCharsets.UTF_8).createProcess()
            process = started
            writer = started.outputStream.bufferedWriter(StandardCharsets.UTF_8)
            problem = null
            ApplicationManager.getApplication().executeOnPooledThread { read(started) }
            ApplicationManager.getApplication().executeOnPooledThread {
                started.errorStream.bufferedReader(StandardCharsets.UTF_8).forEachLine { log.warn("core: $it") }
            }
        } catch (e: Exception) {
            problem = "Code Stories could not start its core process. ${e.message}"
            log.warn(e)
        }
    }

    private fun read(started: Process) {
        try {
            started.inputStream.bufferedReader(StandardCharsets.UTF_8).forEachLine { line ->
                val message = try {
                    JsonParser.parseString(line).asJsonObject
                } catch (e: Exception) {
                    return@forEachLine
                }
                val type = message.get("type")?.asString ?: return@forEachLine
                if (type != "effect" && type != "navigate") {
                    synchronized(latest) { latest[type] = message }
                }
                ApplicationManager.getApplication().invokeLater({
                    for (listener in listeners) {
                        try {
                            listener(message)
                        } catch (e: Exception) {
                            log.warn(e)
                        }
                    }
                }, project.disposed)
            }
        } catch (e: Exception) {
            log.info("core stopped: ${e.message}")
        }
    }

    /** Sends one message to the core. Starts it if it is not running. */
    fun send(message: JsonObject) {
        start()
        synchronized(this) {
            try {
                writer?.apply {
                    write(message.toString())
                    newLine()
                    flush()
                }
            } catch (e: Exception) {
                log.info("could not write to core: ${e.message}")
            }
        }
    }

    fun send(type: String, build: JsonObject.() -> Unit = {}) = send(JsonObject().apply { addProperty("type", type); build() })

    override fun dispose() {
        try {
            writer?.close()
        } catch (_: Exception) {
        }
        process?.destroy()
    }

    companion object {
        fun of(project: Project): Core = project.getService(Core::class.java)
    }
}

/** Starts the core, and with it the editor follow-along, as soon as a project with stories opens. */
class StartCore : ProjectActivity {
    override suspend fun execute(project: Project) {
        val root = project.basePath ?: return
        if (File(root, ".stories").isDirectory) {
            EditorBridge.of(project).start()
        }
        SelfTest.run(project)
    }
}
