# Development

`scripts/` 是全部 Zotero JavaScript 的唯一源码。学生安装器只部署 `sync-attachments.js` 和 `document2md.js`。

## 脚本

| 脚本 | 类型 | 菜单 | 使用 | 调用关系 |
| --- | --- | --- | --- | --- |
| `sync-attachments.js` | 显式 Action | 同步附件 | 学生 / 开发 | 调用 `document2md` |
| `document2md.js` | 隐藏 Action | — | 内部 | 被“同步附件”调用 |
| `sync-to-group.js` | 显式 Action | 同步到课题组 | 开发 | 独立 |
| `item-reset.js` | 显式 Action | 条目重置 | 开发 | 调用三个清理 Action |
| `export-attachments.js` | 显式 Action | 导出附件 | 开发 | 独立 |
| `cleanup-document2md.js` | 隐藏 Action | — | 内部 | 被“条目重置”调用 |
| `clear-all-tags.js` | 隐藏 Action | — | 内部 | 被“条目重置”调用 |
| `clear-all-collections.js` | 隐藏 Action | — | 内部 | 被“条目重置”调用 |
| `auto-inbox-on-create.js` | 自动 Action | — | 开发 | `mainWindowLoad` |

## 固定 Action Key

| Action | Key |
| --- | --- |
| document2md | `1786529156738-JlgQvNK5` |
| 导出附件 | `1786972529220-TGdqst3V` |
| 清空产物 | `1787933471942-TGdqst3V` |
| 清空标签 | `1788320932158-TGdqst3V` |
| 清空分类 | `1788320932160-TGdqst3V` |
| 条目重置 | `item-reset` |
| 同步附件 | `sync-attachments` |
| 同步到课题组 | `sync-to-group` |

## 维护约定

1. `scripts/` 中的 JS 是唯一源码，不在 Actions & Tags 中长期直接修改。
2. 固定 Action Key 不随版本更新改变。
3. `sync-attachments` 只允许在“我的文库”运行。
4. `document2md` 保持隐藏，只由其他 Action 调用。
5. 学生安装器只安装 `sync-attachments` 和 `document2md`。
6. 学生环境固定使用 `DOCUMENT2MD_PROFILE=server`。
7. API Key 只写入用户环境变量，不写入仓库。
8. ProgressWindow 使用 Zotero 默认点击关闭行为，不显式设置 `closeOnClick`。
9. 修改后至少运行 `node --check`，并核对实际 Action 与源码一致。

## 环境变量

```text
DOCUMENT2MD_PROFILE=local|server
CHEN_GROUP_API_KEY=<老师/开发环境>
CHEN_GROUP_API_KEY_MEMBER=<普通成员>
```

需要访问服务器的脚本优先读取 `CHEN_GROUP_API_KEY`，不存在时读取
`CHEN_GROUP_API_KEY_MEMBER`。两者当前服务器权限相同，仅用于区分保密范围和分发对象。
学生固定使用 `DOCUMENT2MD_PROFILE=server`。

## 同步附件

服务器接口：

```text
GET https://api.chen-group.cn/v1/attachments?doi=...
PUT https://api.chen-group.cn/v1/attachments?doi=...&kind=pdf|bundle
```

- 只在个人库写入附件；Group Library 中执行会拒绝。
- 服务器有缓存时复用 PDF、Markdown 和 FIG。
- 缺 PDF 时由 paper-service 检索全文；缺 Markdown 时调用隐藏 `document2md`。
- 本地生成而服务器缺失的 PDF/bundle 会上传；服务器缓存不由客户端覆盖或删除。
- bundle 保持 Markdown 和 `d2md_fig_*` 原文件名。
- 附件接口限流返回 429；客户端对 429/503 每 500 ms 重试，最多 10 次。

## 同步到课题组

目标 Group ID 固定为 `6669851`。

- citationkey 是条目匹配主键；缺失或群组中重复时跳过，不用标题猜测。
- 新条目跨库复制并建立 linked-item 关系；保存前保留源 citationkey。
- Collection 使用 linked-collection 关系保持重命名和移动后的对应关系。
- 选条目时严格镜像该条目的元数据与 Tags；选 Collection 时严格镜像其子树、条目、Tags 和 membership。
- child Note 严格镜像到 Group Library；PDF、Markdown、FIG 不进入 Group Library。
- Better BibTeX `keyScope` 必须为 `library`。

## document2md 与 UI

- `document2md.js` 是唯一文档转 Markdown+FIG 实现。
- `sync-attachments.js` 通过 `dispatchActionByKey()` 调用它。
- `document2md.js` 为隐藏 Action，不显示独立进度或汇总，转换任务串行执行。
- “同步附件”以 5 路并发准备全文，单线程持续消费需要转换的 PDF。
- `document2md` 保留 `local` / `server` 两种后端。
- 显式 Action 的进度使用 `Zotero.ProgressWindow`，确认和选择使用 `Services.prompt`。
- 一次性迁移或修复脚本完成并核验后不长期保留。

## 学生安装器

`install.cmd` 调用 `installer.ps1`。若 Zotero 正在运行，安装器记录实际可执行文件路径、
正常关闭 Zotero，并在安装完成后从原路径重新启动；若原本未运行，则保持未运行。

安装器定位默认 Profile、检查 Actions & Tags、备份 `prefs.js`，安装或更新“同步附件”
和隐藏 `document2md`，并维护 `extensions.actionsTags.rules` 索引。

已有用户级 `CHEN_GROUP_API_KEY_MEMBER` 时先向附件服务验证；有效则直接复用，无效或不存在
才提示输入，并验证新 Key 后写入。安装器同时设置 `DOCUMENT2MD_PROFILE=server`，并更新用户级
及当前进程环境变量。重复运行只更新原 Action，不会创建重复项。

Release 中的 `zotero-actions-student.zip` 只包含 README、安装器、`sync-attachments.js` 和 `document2md.js`。

