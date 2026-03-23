<p align="center">
  <img src="assets/header.svg" width="480" alt="DesignCode — Agent-powered graphic design workbench" />
</p>

<div align="center">

**English** ｜ [简体中文](README.zh-CN.md) ｜ [日本語](README.ja.md)



<a href="https://github.com/haruhiyuki/DesignCode/releases/latest"><img src="https://img.shields.io/badge/release-1.0.0-blue" alt="version" /></a>
<a href="https://github.com/haruhiyuki/DesignCode/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" /></a>
<a href="https://v2.tauri.app"><img src="https://img.shields.io/badge/tauri-v2.0-orange" alt="tauri" /></a>
<a href="https://vuejs.org"><img src="https://img.shields.io/badge/vue-3-green" alt="vue" /></a>

<br>

<a href="#features">Features</a> ｜
<a href="#quick-start">Quick Start</a> ｜
<a href="#how-it-works">How It Works</a> ｜
<a href="#about">About</a> ｜
<a href="#license">License</a>

</div>

DesignCode is an agent-based graphic design workbench that transforms simple instructions into high-quality design drafts. It supports production-grade features such as vector-level lossless output, multi-layer PSD export, art asset management, and style presets. In areas like multi-turn instruction following, editability, and text rendering, it offers advantages that traditional AI image generation models cannot match.

DesignCode supports a wide range of graphic design needs, including but not limited to posters, postcards, product detail pages, media promotional graphics, static web designs, book covers, and typographic layouts — any scenario involving text content.

## Features

1. Describe your requirements directly to the Agent in the chat panel, receive a complete design draft, and iterate through continuous conversation.
2. Preview the design in real-time on the canvas, with direct text editing capability.
3. Get vector-level output — export as high-resolution PNG, SVG, or PDF.
4. Export multi-layer PSD files where each layer has a proper alpha channel.
5. Pre-configure size requirements, style presets, and content fields from the menu.
6. Build a user-level asset library, and select which assets to use in each design.
7. Supports Codex, Claude Code, OpenCode, and Gemini CLI.
8. Full version history — every single adjustment can be traced back.
9. i18n-based internationalization support.
10. Cross-platform — supports macOS and Windows.

## Quick Start

### Using Installers

For users who want to get started quickly, download the installer for your platform from [Releases](https://github.com/haruhiyuki/DesignCode/releases/latest).

DesignCode requires an Agent backend to function, and comes with Codex, OpenCode, and Gemini CLI built in. You can obtain an API key for any model to use with OpenCode, or use Codex and Gemini CLI through their respective subscriptions.

DesignCode includes support for Claude Code, but due to licensing restrictions, Claude Code cannot be bundled with the project. If you wish to use it, please install it separately.

### Building from Source

If you need to customize DesignCode or want early access to unreleased updates, make sure you have `Node.js ≥ 18` and a `Rust` toolchain, install a supported Agent CLI, and build from source.

```bash
# Clone the repository
git clone https://github.com/haruhiyuki/DesignCode.git
cd DesignCode

# Install dependencies
npm install

# Desktop development mode
# macOS
npm run desktop:dev
# Windows
npm run desktop:dev:windows

# — or build a distributable package —
# macOS
npm run desktop:build
# Windows
npm run desktop:build:windows
```

## How It Works

DesignCode's unique advantages stem from its technical approach. Unlike image generation models that use diffusion techniques, DesignCode uses HTML / CSS / SVG as its design medium, making it far better suited for graphic design scenarios that demand high-quality text typesetting, clarity, and editability.

The expanding capability boundary of LLMs has made this approach viable. Leading models' ability to write aesthetically pleasing front-end code and SVG graphics is growing rapidly, and current top-tier models have proven capable of handling most design tasks well.

## About

DesignCode is published by the **Haruhi Suzumiya Dev Group**.

The **Haruhi Suzumiya Dev Group** is an affiliate of the [**Haruhi Suzumiya Fan Club**](https://space.bilibili.com/201296348), dedicated to creating more projects that make the world a more exciting place.

Feel free to submit your application to join via haruhifanclub@outlook.com!

## License

[Apache License 2.0](LICENSE)
