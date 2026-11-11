# Zotero Actions

课题组 Zotero 附件同步脚本。学生日常只需使用“同步附件”。

## 安装

1. 安装 [Zotero 10](https://www.zotero.org/download/)。
2. 安装 [Zotero Actions & Tags](https://github.com/windingwind/zotero-actions-tags/releases)。
3. 下载 [zotero-actions-student.zip](https://github.com/yu-chengchen-group/zotero-actions/releases/latest/download/zotero-actions-student.zip)。
4. 解压后运行 `install.cmd`，按提示输入课题组 API Key。

安装后，在“我的文库”中右键文献或 Collection，选择“同步附件”。

## 同步逻辑

- 普通成员只从服务器读取附件，不写入课题组缓存。
- 以 DOI 或共享 Cache-Key 定位文献，获取该文献的全部原文件及 Markdown ZIP；正文、SI、DOCX 等独立同步。
- 不依赖学生个人文库的 Zotero 附件 Key；下载后以个人附件标签记录服务器附件 ID。
- 已有本地附件内容与云端不一致时保留本地文件，不自动覆盖；必要时另建云端附件。
- 源文件不存在 Markdown 时优先下载服务器产物；若服务器没有，调用公网 document2md 生成本地版本。
- 未发布附件的 DOI 可自动检索正文 PDF；其他附件需要教师发布。
- 旧版单 PDF 缓存接口不再兼容，需先升级服务和脚本，再由教师重新发布。

## 群组库

群组库只同步元数据、标签和分类，不同步附件。需要全文时，将文献加入“我的文库”后执行“同步附件”。

## 更新

从最新 Release 下载 `zotero-actions-student.zip`，解压后运行 `update.cmd`；首次安装运行 `install.cmd`。
可运行 `doctor.cmd` 检查环境，`uninstall.cmd` 移除学生端脚本。发布安装包由仓库根目录 `package-student.ps1` 统一生成。

## 相关仓库

- [paper-service](https://github.com/yu-chengchen-group/paper-service)：提供附件同步与全文获取接口。
- [document2md](https://github.com/yu-chengchen-group/document2md)：提供 PDF/文档转 Markdown 服务。
