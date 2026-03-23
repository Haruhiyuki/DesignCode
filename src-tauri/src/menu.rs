// 应用菜单构建和本地化

use crate::types::MenuLabels;
use tauri::AppHandle;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

pub fn menu_labels(locale: &str) -> MenuLabels {
    match locale {
        "zh-CN" => MenuLabels {
            file: "文件",
            new_design: "新建设计稿",
            export_html: "导出 HTML",
            export_png: "导出 PNG",
            export_svg: "导出 SVG",
            export_pdf: "导出 PDF",
            export_psd: "导出 PSD",
            edit: "编辑",
            view: "视图",
            fit_canvas: "适配画布",
            fullscreen: "全屏编辑",
            design: "设计",
            generate: "生成设计",
            edit_design: "提交修改",
            window: "窗口",
            help: "帮助",
            about: "关于 DesignCode",
            check_updates: "检查更新…",
            export: "导出",
        },
        "ja" => MenuLabels {
            file: "ファイル",
            new_design: "新しいデザイン",
            export_html: "HTMLとして書き出す",
            export_png: "PNGとして書き出す",
            export_svg: "SVGとして書き出す",
            export_pdf: "PDFとして書き出す",
            export_psd: "PSDとして書き出す",
            edit: "編集",
            view: "表示",
            fit_canvas: "キャンバスに合わせる",
            fullscreen: "フルスクリーン編集",
            design: "デザイン",
            generate: "デザインを生成",
            edit_design: "変更を提出",
            window: "ウインドウ",
            help: "ヘルプ",
            about: "DesignCode について",
            check_updates: "アップデートを確認…",
            export: "書き出す",
        },
        _ => MenuLabels {
            file: "File",
            new_design: "New Design",
            export_html: "Export HTML",
            export_png: "Export PNG",
            export_svg: "Export SVG",
            export_pdf: "Export PDF",
            export_psd: "Export PSD",
            edit: "Edit",
            view: "View",
            fit_canvas: "Fit Canvas",
            fullscreen: "Fullscreen Edit",
            design: "Design",
            generate: "Generate Design",
            edit_design: "Submit Edit",
            window: "Window",
            help: "Help",
            about: "About DesignCode",
            check_updates: "Check for Updates…",
            export: "Export",
        },
    }
}

pub fn build_app_menu(app: &AppHandle, locale: &str) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    let l = menu_labels(locale);

    let export_sub = SubmenuBuilder::new(app, l.export)
        .item(&MenuItemBuilder::with_id("export-html", l.export_html).accelerator("CmdOrCtrl+Shift+E").build(app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("export-png", l.export_png).build(app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("export-svg", l.export_svg).build(app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("export-pdf", l.export_pdf).build(app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("export-psd", l.export_psd).build(app).map_err(|e| e.to_string())?)
        .build().map_err(|e| e.to_string())?;

    let file_menu = SubmenuBuilder::new(app, l.file)
        .item(&MenuItemBuilder::with_id("new-design", l.new_design).accelerator("CmdOrCtrl+N").build(app).map_err(|e| e.to_string())?)
        .separator()
        .item(&export_sub)
        .separator()
        .close_window()
        .build().map_err(|e| e.to_string())?;

    let edit_menu = SubmenuBuilder::new(app, l.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build().map_err(|e| e.to_string())?;

    let view_menu = SubmenuBuilder::new(app, l.view)
        .item(&MenuItemBuilder::with_id("fit-canvas", l.fit_canvas).accelerator("CmdOrCtrl+0").build(app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("fullscreen-edit", l.fullscreen).build(app).map_err(|e| e.to_string())?)
        .build().map_err(|e| e.to_string())?;

    let design_menu = SubmenuBuilder::new(app, l.design)
        .item(&MenuItemBuilder::with_id("generate-design", l.generate).accelerator("CmdOrCtrl+Return").build(app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("edit-design", l.edit_design).accelerator("CmdOrCtrl+Shift+Return").build(app).map_err(|e| e.to_string())?)
        .build().map_err(|e| e.to_string())?;

    let window_menu = SubmenuBuilder::new(app, l.window)
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build().map_err(|e| e.to_string())?;

    let help_menu = SubmenuBuilder::new(app, l.help)
        .item(&MenuItemBuilder::with_id("about", l.about).build(app).map_err(|e| e.to_string())?)
        .item(&MenuItemBuilder::with_id("check-updates", l.check_updates).build(app).map_err(|e| e.to_string())?)
        .build().map_err(|e| e.to_string())?;

    MenuBuilder::new(app)
        .items(&[&file_menu, &edit_menu, &view_menu, &design_menu, &window_menu, &help_menu])
        .build()
        .map_err(|e| e.to_string())
}
