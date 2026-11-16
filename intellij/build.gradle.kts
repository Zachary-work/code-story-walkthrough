// The IntelliJ plugin. It is a thin layer: the review logic is the shared core in ../src/core
// (run as a Node process), and the panel is the shared web UI in ../media.
//
// Build:  npm run compile   (in the repository root, once, to produce ../out/core)
//         gradlew buildPlugin
// The plugin zip lands in build/distributions.
//
// To build against an IntelliJ already installed on this machine instead of downloading one,
// pass -PlocalIde="C:/Program Files/JetBrains/IntelliJ IDEA 2026.3" or set localIde in
// ~/.gradle/gradle.properties.
plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.10"
    id("org.jetbrains.intellij.platform") version "2.20.1"
}

group = "dev.codestories"
version = "0.4.3"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

val localIde = providers.gradleProperty("localIde")

dependencies {
    intellijPlatform {
        if (localIde.isPresent) {
            local(localIde.get())
        } else {
            create("IU", "2026.3")
        }
        // The embedded browser (JCEF) is its own bundled plugin since 2026.3.
        bundledPlugin("com.intellij.modules.jcef")
    }
}

intellijPlatform {
    buildSearchableOptions = false
    pluginConfiguration {
        ideaVersion {
            // Compiled and checked against 2026.3 only. Lower this after running the plugin verifier on older builds.
            sinceBuild = "263"
            untilBuild = provider { null }
        }
    }
}

// The sandbox IDE opens the project straight away, without first-run dialogs.
// -PselfTest=<folder> runs the scripted check in SelfTest.kt and writes its results there.
tasks.runIde {
    jvmArgs("-Didea.trust.all.projects=true", "-Dide.show.tips.on.startup.default.value=false", "-Djb.consents.confirmation.enabled=false", "-Djb.privacy.policy.text=<!--999.999-->")
    providers.gradleProperty("selfTest").orNull?.let { environment("CODE_STORIES_SELFTEST", it) }
}

// The shared core, the shared panel and the agent skill ship as plain files next to the plugin's jar.
val shared = rootProject.layout.projectDirectory.dir("..")
// Every sandbox gets them: the one that is zipped for distribution and the one runIde starts.
tasks.withType<org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask>().configureEach {
    val core = shared.dir("out/core")
    doFirst {
        check(core.file("server.js").asFile.exists()) { "Run \"npm run compile\" in the repository root first: ${core.asFile} has no server.js" }
    }
    from(core) {
        into(pluginName.map { "$it/core" })
        include("**/*.js")
    }
    from(shared.dir("media")) {
        into(pluginName.map { "$it/media" })
        include("panel.js", "panel.css")
    }
    from(shared.dir("skill")) {
        into(pluginName.map { "$it/skill" })
    }
}
