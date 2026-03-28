<p align="center">
  <img src="assets/header.ja.svg" width="480" alt="DesignCode — Agent駆動のグラフィックデザインワークベンチ" />
</p>

<div align="center">

[English](README.md) ｜ [简体中文](README.zh-CN.md) ｜ **日本語**



<a href="https://github.com/haruhiyuki/DesignCode/releases/latest"><img src="https://img.shields.io/badge/release-1.0.3-blue" alt="version" /></a>
<a href="https://github.com/haruhiyuki/DesignCode/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="license" /></a>
<a href="https://v2.tauri.app"><img src="https://img.shields.io/badge/tauri-v2.0-orange" alt="tauri" /></a>
<a href="https://vuejs.org"><img src="https://img.shields.io/badge/vue-3-green" alt="vue" /></a>

<br>

<a href="#機能">機能</a> ｜
<a href="#クイックスタート">クイックスタート</a> ｜
<a href="#仕組み">仕組み</a> ｜
<a href="#about">About</a> ｜
<a href="#license">License</a>

</div>

DesignCodeは、Agentベースのグラフィックデザインワークベンチです。簡単な指示を高品質なデザインカンプに変換し、ベクターレベルの無劣化出力、マルチレイヤーPSD書き出し、アートアセット管理、スタイルプリセットなど、プロダクションレベルの機能をサポートしています。マルチターン指示追従、編集可能性、テキストレンダリングなどの面で、従来のAI画像生成モデルでは代替できない優位性を持っています。

DesignCodeは、ポスター、ポストカード、商品詳細ページ、メディア宣伝画像、静的Webデザイン、書籍カバー、タイポグラフィなど、テキストコンテンツを含むあらゆるグラフィックデザインのニーズに幅広く対応します。

## 機能

1. チャットパネルでAgentに要件を直接伝え、完成したデザインカンプを受け取り、継続的な会話で調整できます。
2. キャンバス上でデザインをリアルタイムプレビューし、テキストを直接編集できます。
3. ベクターレベルの出力 — 高解像度PNG、SVG、PDFとして書き出し可能。
4. マルチレイヤーPSDファイルを書き出し可能。各レイヤーは正常なアルファチャンネルを保持します。
5. メニューからサイズ要件、スタイルプリセット、コンテンツフィールドを事前設定できます。
6. ユーザーレベルのアセットライブラリを構築し、各デザインで使用するアセットを選択できます。
7. Codex、Claude Code、OpenCode、Gemini CLIに対応。
8. 完全な履歴管理機能 — すべての調整を遡ることができます。
9. i18nベースの国際化対応。
10. クロスプラットフォーム — macOS、Windowsに対応。

## クイックスタート

### インストーラーを使用

すぐに使い始めたいユーザーは、[Releases](https://github.com/haruhiyuki/DesignCode/releases/latest)からお使いのプラットフォーム向けのインストーラーをダウンロードしてください。

DesignCodeの利用にはAgentバックエンドが必要で、Codex、OpenCode、Gemini CLIが内蔵されています。任意のモデルのAPIキーを取得してOpenCodeで使用するか、それぞれのサブスクリプションを通じてCodexやGemini CLIを利用できます。

DesignCodeはClaude Codeにも対応していますが、ライセンス上の制約により、Claude Codeをプロジェクトにバンドルすることができません。使用する場合は別途インストールしてください。

### ソースからビルド

カスタマイズが必要な場合や、未リリースの最新アップデートを早期に入手したい場合は、`Node.js ≥ 18`と`Rust`ツールチェーンを用意し、対応するAgent CLIをインストールしてから、ソースからビルドしてください。

```bash
# リポジトリをクローン
git clone https://github.com/haruhiyuki/DesignCode.git
cd DesignCode

# 依存関係をインストール
npm install

# デスクトップ開発モード
# macOS
npm run desktop:dev
# Windows
npm run desktop:dev:windows

# — または配布パッケージをビルド —
# macOS
npm run desktop:build
# Windows
npm run desktop:build:windows
```

## 仕組み

DesignCodeの独自の優位性は、その技術的アプローチに由来します。拡散生成技術を使用する画像生成モデルとは異なり、DesignCodeはHTML / CSS / SVGをデザイン媒体として使用するため、テキスト組版、鮮明さ、編集可能性が求められるグラフィックデザインのシナリオにはるかに適しています。

LLMの能力境界の拡大により、このアプローチが実現可能になりました。トップモデルが美しいフロントエンドコードとSVGグラフィックスを書く能力は急速に向上しており、現在の最先端モデルはほとんどのデザインタスクを十分にこなせることが実証されています。

## About

DesignCodeは**涼宮ハルヒ開発グループ**により公開されています。

**涼宮ハルヒ開発グループ**は[**涼宮ハルヒ応援団**](https://space.bilibili.com/201296348)の関連組織であり、世界をもっと盛り上げるプロジェクトの創造に取り組んでいます。

参加申請はharuhifanclub@outlook.comまでお気軽にどうぞ！

## License

[Apache License 2.0](LICENSE)
