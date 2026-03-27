<p align="center">
  <img src="assets/header.zh-CN.svg" width="480" alt="DesignCode — AI 驱动的平面设计工作台" />
</p>

<div align="center">

[English](README.md) ｜ **简体中文** ｜ [日本語](README.ja.md)



<a href="https://github.com/haruhiyuki/DesignCode/releases/latest"><img src="https://img.shields.io/badge/release-1.0.2-blue" alt="version" /></a>
<a href="https://github.com/haruhiyuki/DesignCode/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" /></a>
<a href="https://v2.tauri.app"><img src="https://img.shields.io/badge/tauri-v2.0-orange" alt="tauri" /></a>
<a href="https://vuejs.org"><img src="https://img.shields.io/badge/vue-3-green" alt="vue" /></a>

<br>

<a href="#功能特性">功能特性</a> ｜
<a href="#快速开始">快速开始</a> ｜
<a href="#工作原理">工作原理</a> ｜
<a href="#about">About</a> ｜
<a href="#license">License</a>

</div>

DesignCode 是一个基于 Agent 的平面设计工作台，可将简单指令转换成高质量的平面设计稿，并支持矢量级无损输出、多图层PSD导出、美术资产管理、风格预设等生产级特性，在多轮次指令遵循、可编辑性、文本渲染能力等方面具有传统 AI 生图模型无法替代的优势。

DesignCode 广泛支持各类型的平面设计需求，包括但不限于海报、明信片、商品详情页、媒体宣传图、静态网页设计、书籍封面、排版等含有文本内容的场景。

## 功能特性

1. 在对话框中向 Agent 直接描述你的需求，获得完整的设计稿，并在连续的对话中进行调整。
2. 在画布中实时预览设计，并可对文本进行直接编辑。
3. 获取矢量级输出，可导出高清 PNG、SVG、PDF 文件。
4. 可导出多图层PSD文件，每个图层都具有正常的透明通道。
5. 可在菜单中预先配置尺寸要求、风格预设、内容字段。
6. 建立用户级素材库，并在每个设计稿中选择使用哪些素材。
7. 支持使用 Codex、Claude Code、OpenCode、Gemini CLI。
8. 拥有完整的历史记录功能，每一次调整都可回溯。
9. 基于 i18n 的国际化支持。
10. 跨平台，支持 macOS、Windows。


## 快速开始

### 使用安装包

对于希望快速使用 DesignCode 的用户，可在 [Releases](https://github.com/haruhiyuki/DesignCode/releases/latest) 中下载对应系统的安装包。

DesignCode 需要接入 Agent 进行使用，并且已经内置了Codex、OpenCode和Gemini CLI。你可以获取任意模型的 API Key 从而在OpenCode中使用，或者通过相应的订阅使用 Codex 和 Gemini CLI。

DesignCode 添加了对Claude Code的支持，但由于使用限制，我们不能在项目中打包 Claude Code，如需使用需要自行安装。

### 从代码构建

如果你有二次开发的需求，或希望快速获取 DesignCode 的非正式更新，请确保拥有 `Node.js ≥ 18` 以及 `Rust` 环境，自行安装受支持的 Agent CLI ，并从代码构建。

```bash
# 克隆仓库
git clone https://github.com/haruhiyuki/DesignCode.git
cd DesignCode

# 安装依赖
npm install

# 桌面开发模式
# mac
npm run desktop:dev
# windows
npm run desktop:dev:windows

# —— 或构建分发包 ——
# mac
npm run desktop:build
# windows
npm run desktop:build:windows
```

## 工作原理
DesignCode 的独特优势来源于其技术路线，与使用扩散生成技术的图片生成模型不同，DesignCode 使用 HTML / CSS / SVG 作为设计媒介，从而更加适应对文本排版、清晰度、可编辑性要求较高的平面设计场景。

LLM 能力边界的扩张使该路线变得可行，顶尖模型编写美观的前端代码与 SVG 图形的能力正在与日俱增，目前较为领先的模型经测试均能很好地胜任多数设计任务。

## About

DesignCode 由 **凉宫春日开发组** 发布。

**凉宫春日开发组** 是 [**凉宫春日应援团**](https://space.bilibili.com/201296348) 的附属组织，致力于创造更多让世界变得更加热闹的项目。

欢迎通过 haruhifanclub@outlook.com 投递加入申请！

## License

[Apache License 2.0](LICENSE)
