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
6. `document2md` 根据 API Key 自动选后端：教师 Key 走本地服务，成员 Key 走服务器官方 API。
7. API Key 只写入用户环境变量，不写入仓库。
8. ProgressWindow 使用 Zotero 默认点击关闭行为，不显式设置 `closeOnClick`。
9. 修改后至少运行 `node --check`，并核对实际 Action 与源码一致。

## 环境变量

```text
CHEN_GROUP_API_KEY=<老师/开发环境>
CHEN_GROUP_API_KEY_MEMBER=<普通成员>
```

需要访问服务器的脚本优先读取 `CHEN_GROUP_API_KEY`，不存在时读取
`CHEN_GROUP_API_KEY_MEMBER`。导师 Key 是附件发布者；成员 Key 是只读消费者。
`document2md` 不再读取 `DOCUMENT2MD_PROFILE`：存在导师 Key 时固定调用本地
`http://127.0.0.1:18321/process`；只有成员 Key 时固定调用公网异步 document2md。

## 同步附件

服务器接口：

```text
GET https://api.chen-group.cn/v1/attachments?doi=...
PUT https://api.chen-group.cn/v1/attachments?doi=...&kind=pdf|bundle
```

- 只在个人库写入附件；Group Library 中执行会拒绝。
- 教师和学生都先以 8 路并发执行 `cache_only=1` 服务器检查；进度分别显示“已检查”和“已处理”，进度条在检查阶段从 0% 到 50%、处理阶段从 50% 到 100%，不倒退，也不由多个 worker 相互覆盖条目标题。
- `CHEN_GROUP_API_KEY` 为教师发布模式：必须明确选择文献或 Collection；本地 PDF 是 source-of-truth。服务器 PDF SHA-256 与本地一致且 bundle 已存在时直接记为“已一致”，否则才串行发布。
- `CHEN_GROUP_API_KEY_MEMBER` 为学生消费模式：只允许 GET，不调用附件 PUT。服务器 PDF SHA-256 与本地不一致时，以服务器版本替换本地 PDF 和 bundle；缺 PDF 时仍由 paper-service 检索全文。
- 教师缺失/失配 Markdown 时调用本地 document2md；学生缺失/失配 Markdown 时调用公网 document2md，由服务器走官方 API。
- PDF 转换得到的 Markdown 第一行固定记录 `<!-- document2md-source-pdf-sha256: ... -->`，`sync-attachments.js` 用它验证本地 Markdown 与 PDF 是否一致。
- bundle 保持 Markdown 和 `d2md_fig_*` 原文件名。
- 附件接口限流返回 429；客户端对 429/503 每 500 ms 重试，最多 10 次。
- 有真实 DOI 时以规范化 DOI 作为附件缓存身份。
- 无 DOI 时在父条目 Extra 中保存一次性固定 `Cache-Key: chen:<UUIDv4>`；Zotero 元数据同步后，各设备使用同一 Cache-Key 共享 PDF/bundle 缓存。
- Cache-Key 只用于附件缓存，不写入 DOI 字段；无 DOI 条目不会触发 paper-service DOI 全文检索，只复用已有缓存或处理本地 PDF。

## 同步到课题组

目标 Group ID 固定为 `6669851`。

- citationkey 是条目匹配主键；缺失或群组中重复时跳过，不用标题猜测。
- 新条目跨库复制并建立 linked-item 关系；保存前保留源 citationkey。
- Collection 使用 linked-collection 关系保持重命名和移动后的对应关系。
- 选条目时严格镜像该条目的元数据与 Tags；选 Collection 时严格镜像其子树、条目、Tags 和 membership。
- 只镜像机器生成的 `Classification Record` 和 `Citations`（含 `Citations000` 等分段）child Note；按 Note 类型保留最新版并去重。个人库是受管理 Note 的真值源；源 Note 删除后只删除对应机器 Note，人工 Note 不覆盖、不删除。PDF、Markdown、FIG 不进入 Group Library。
- 修改 Note 镜像逻辑后运行 `node --test tests/sync-to-group-notes.test.js`；本地模拟测试不替代实际 Zotero/Group 同步验收。
- Better BibTeX `keyScope` 必须为 `library`。

## document2md 与 UI

- `document2md.js` 是唯一文档转 Markdown+FIG 实现。
- `document2md` 服务直接在 PDF Markdown 第一行写入 `document2md-source-pdf-sha256` provenance；`document2md.js` 原样保存 `page_content`，不重复计算或拼接 hash。
- `sync-attachments.js` 通过 `dispatchActionByKey()` 调用它。
- `document2md.js` 为隐藏 Action，不显示独立进度或汇总，转换任务串行执行。
- “同步附件”统一使用 8 路并发执行服务器检查和学生后续同步更新；document2md 转换仍串行，教师发布始终串行。
- `document2md` 保留 `local` / `server` 两种后端。
- 显式 Action 的进度使用 `Zotero.ProgressWindow`，确认和选择使用 `Services.prompt`。
- 一次性迁移或修复脚本完成并核验后不长期保留。

## 学生安装器

`install.cmd` 调用 `installer.ps1`。若 Zotero 正在运行，安装器记录实际可执行文件路径、
正常关闭 Zotero，并在安装完成后从原路径重新启动；若原本未运行，则保持未运行。

安装器定位默认 Profile、检查 Actions & Tags、备份 `prefs.js`，安装或更新“同步附件”
和隐藏 `document2md`，并维护 `extensions.actionsTags.rules` 索引。

已有用户级 `CHEN_GROUP_API_KEY_MEMBER` 时先向附件服务验证；有效则直接复用，无效或不存在
才提示输入，并验证新 Key 后写入。安装器只维护成员 Key；document2md 后端由脚本根据 Key 自动确定。
重复运行只更新原 Action，不会创建重复项。

Release 中的 `zotero-actions-student.zip` 只包含 README、安装器、`sync-attachments.js` 和 `document2md.js`。

