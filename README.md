# Zotero Actions

课题组 Zotero 附件同步工具。学生日常使用“同步附件”。

## 首次安装

准备：

1. [Zotero](https://www.zotero.org/download/)
2. [Zotero Actions & Tags](https://github.com/windingwind/zotero-actions-tags/releases)

下载并解压：

[zotero-actions-student.zip](https://github.com/yu-chengchen-group/zotero-actions/releases/latest/download/zotero-actions-student.zip)

双击：

```text
install.cmd
```

按提示输入课题组成员 API Key。

安装完成后双击：

```text
doctor.cmd
```

验证通过后，在 Zotero“我的文库”中右键文献或 Collection，即可使用“同步附件”。

## 日常使用

“同步附件”负责：

- 从课题组附件服务获取已有 PDF、Markdown 和图片
- 根据 PDF SHA-256 同步服务器新版附件
- 为可获取全文的文献取得 PDF
- 为本地 PDF 生成或更新 Markdown
- 在需要人工获取 PDF 时显示提示

课题组群组库共享文献元数据、标签和分类；附件在个人库中使用。

使用步骤：

1. 将需要的文献加入“我的文库”。
2. 选中文献或 Collection。
3. 右键选择“同步附件”。

## 更新

下载并解压最新的 `zotero-actions-student.zip`。

双击：

```text
update.cmd
```

随后运行：

```text
doctor.cmd
```

验证通过后即可继续使用。

## 同步模型

学生使用 `CHEN_GROUP_API_KEY_MEMBER` 访问课题组附件服务。

附件同步方向：

```text
课题组附件服务
        ↓
   学生个人库
```

本地 Markdown 由 document2md 按当前 PDF 内容生成。

## 卸载

关闭 Zotero，然后双击：

```text
uninstall.cmd
```

该操作移除课题组 Action 和成员 API Key。Zotero 与 Actions & Tags 保持原安装状态。
