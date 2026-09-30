# Zotero Actions

课题组 Zotero 附件同步脚本。学生日常只需要使用 **同步附件**。

## 安装

1. 安装 [Zotero 10](https://www.zotero.org/download/)。
2. 安装 [Zotero Actions & Tags](https://github.com/windingwind/zotero-actions-tags/releases)。
3. 下载并解压 [zotero-actions-student.zip](https://github.com/ycchen-FZU/zotero-actions/releases/latest/download/zotero-actions-student.zip)。
4. 双击 `install.cmd`。
5. 按提示输入课题组 API Key。

安装完成后，在“我的文库”中右键文献或 Collection，即可看到 **同步附件**。

## 同步附件在做什么？

学生使用 `CHEN_GROUP_API_KEY_MEMBER`，附件只从服务器流向本地。

- 如果教师已经发布过这篇文献，会直接复用服务器 PDF、Markdown 和相关图片。
- 如果教师后来发布了新版 PDF，学生再次执行“同步附件”时会按 PDF SHA-256 自动刷新本地 PDF 和 Markdown bundle。
- 服务器缺 PDF 时，会自动尝试查找全文；找到后下载到本地。
- 服务器没有 Markdown 时，会调用公网 document2md 生成本地 Markdown，但不会上传或覆盖课题组缓存。
- 自动检索失败时，会提示需要人工下载 PDF。
- 普通成员没有附件缓存写权限。

## 群组库怎么用？

课题组群组库只同步文献的元数据、标签和分类，不同步 PDF、Markdown 和图片。

需要全文时：

1. 将需要的文献从群组库加入“我的文库”。
2. 在“我的文库”中选中文献或 Collection。
3. 右键 → **同步附件**。

“同步附件”只在“我的文库”中运行。

## 更新

下载新版 `zotero-actions-student.zip` 后，重新运行 `install.cmd` 即可。

