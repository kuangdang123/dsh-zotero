# dsh-zotero

把本机 Zotero 接到 DeepSeek Harness 上：直接查库、改库、批量入库，读 PDF 高亮/批注和笔记，取 Zotero 已建好的全文索引，按 DOI 找相关论文。

> English: a DeepSeek Harness bundle that talks to a local Zotero library — search, read and edit items, bulk-add papers, and read PDF annotations, notes and indexed full text.

Zotero 7 的本地 API 只有只读接口，写入能力是较新版本加入的（本机 Zotero 10.0.7 已验证读写都可用）。本插件走的就是 Zotero 自带的 `http://127.0.0.1:23119/api/`，不需要在 Zotero 里装任何插件。

## 〇、安装

三种方式，任选其一：

1. **从 GitHub 装**（推荐）：把仓库地址交给 `plugin_manager install_bundle`，例如
   `git+https://github.com/kuangdang123/dsh-zotero.git`；也可以先 `git clone` 到本地，再把本地目录路径传给 `install_bundle`。
2. **从插件市场索引装**：在本机 DSH 的「插件 → 发现」里添加索引地址
   `https://raw.githubusercontent.com/kuangdang123/dsh-zotero/main/market/index.json`
   （该文件由 `npm run index` 生成，每个版本固定到具体 commit），然后点安装。
3. **作为本地 bundle 开发**：仓库根目录本身就是 bundle，`plugin_manager install_bundle` 传本目录绝对路径即可（装成 link，改代码后禁用/启用插件重载）。

安装后无需重启 Zotero，但要先完成下一节的开关。

## 一、开启 Zotero 本地 API（一次性）

1. 打开 Zotero → 设置（Preferences）→ 高级（Advanced）。
2. 勾选 **「允许此计算机上的其他应用程序与 Zotero 通讯」**（英文界面：*Allow other applications on this computer to communicate with Zotero*）。
3. 勾选后同一面板会显示一行 **「可用于 http://127.0.0.1:23119/api/」**。看到这行就说明接口已开。
4. 读操作立刻生效；写操作（新增/修改/删除）第一次会弹出 Zotero 授权框，见下一节。

> 如果 Zotero 没开，插件会提示 `NOT USABLE`；如果开了 Zotero 但没勾选这一项，会提示 403 `Local API is not enabled`。

## 二、写权限：Zotero 会问你一次

Zotero 对写操作单独鉴权。第一次调用会写库的工具时，Zotero 会弹出对话框询问是否允许本应用写入：

- 选 **「始终允许」**（Remember）：key 会长期有效，之后不再询问。
- 选「仅此一次」：key 用一次就失效，下次写又要弹框。

key 保存在 `$DSH_PROFILE_DIR/plugin-data/dsh-zotero/auth.json`（通常形如 `C:\Users\<你>\.dsh\profiles\web\plugin-data\dsh-zotero\auth.json`）。要撤销授权，可在 Zotero 高级面板点「清除写入授权」，或删掉这个文件。

## 三、工具一览

| 工具 | 作用 |
| --- | --- |
| `zotero_status` | 体检：接口是否可用、server id、有没有写 key、库里多少条目/合集/标签。先调它排障。 |
| `zotero_search` | 查库：标题/作者/年份/任意字段搜索，按类型、标签、合集、回收站过滤，可按日期排序。默认只列顶层条目（附件、批注不刷屏），要单列某类子条目时再用 `itemType`。 |
| `zotero_get` | 读单条或多条：元数据、作者、标签、合集、子条目（附件/笔记）、可选笔记正文、批注、全文、BibTeX。 |
| `zotero_annotations` | **精读主力**：按阅读顺序读出某篇论文的全部高亮/下划线/批注（含引文、你的批注、页码、颜色），并附上这篇论文下的笔记。 |
| `zotero_fulltext` | 读 Zotero 已索引的 PDF 正文，支持分页（offset/maxChars）和按短语跳转（find）。 |
| `zotero_note` | 管理笔记条目：create / append / get / list / delete。正文用 Markdown 写，自动转成 Zotero 笔记 HTML。 |
| `zotero_add` | 入库：按 DOI/arXiv/PMID/ISBN/URL 抓元数据；或给原始 Zotero item JSON；或给一个课题让 OpenAlex/Crossref/arXiv 搜出前几条；可指定合集、标签、是否跳过重复、dryRun 预览。 |
| `zotero_attach` | 挂文件：把本机 PDF/EPUB/TXT 上传进 Zotero storage，作为指定条目的附件（走本地 API 的三段式上传）。上传后会顺手唤醒 Zotero 的全文索引队列，几秒内即可 `zotero_fulltext`；加 `wait: true` 则等到真正索引完成再返回。 |
| `zotero_update` | 改一条：合并字段补丁、加/删标签、加/移合集、入回收站/恢复。 |
| `zotero_delete` | 删：默认入回收站；`permanent: true` 永久删除，且必须 `confirm: true` 才执行。 |
| `zotero_collections` | 合集管理：list / tree / get / create / rename / delete。 |
| `zotero_find` | 找新论文：多源搜索（不走本地库），或按 DOI 取 OpenAlex 的相关工作/参考文献/被引，用来批量扩检。 |

## 四、几种典型用法

**精读一篇论文**

```
zotero_search   { "query": "retrieval augmented generation" }
zotero_annotations { "key": "ABCD1234" }        // 你在 PDF 里的高亮与批注，按页码顺序
zotero_fulltext { "key": "ABCD1234", "find": "limitations" }
zotero_get      { "key": "ABCD1234", "notes": true }
```

**把一批 DOI 拉进库并归到一个合集**

```
zotero_add {
  "identifiers": ["10.1145/3292500", "arXiv:2101.00001", "978-3-16-148410-0"],
  "collection": "待读",
  "tags": ["2026-11"],
  "dryRun": true
}
```

`dryRun: true` 只解析和报告，不写库；确认无误后去掉它再跑一次。

**按课题批量找论文**

```
zotero_find { "query": "graph neural networks for molecular property prediction", "limit": 10 }
zotero_add  { "search": "graph neural networks for molecular property prediction", "limit": 5, "collection": "GNN" }
```

**顺着引用扩检**

```
zotero_find { "related_to": "10.1145/3292500" }
```

**边读边把结论写回 Zotero**

```
zotero_note { "action": "create", "item": "ABCD1234", "content": "## 核心贡献\n- ...\n\n## 疑问\n- ..." }
zotero_note { "action": "append", "note": "NOTE5678", "content": "补一段实验对比。" }
```

## 五、配置项（可选）

在 profile 的 `cordis.patch.yml` 里给插件传 config；不传就用默认值。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:23119/api` | 本地 API 根地址。改端口时才需要动。 |
| `userId` | `0` | 用户库 id，`0` 表示当前用户。 |
| `timeoutMs` | `20000` | 单次 HTTP 超时（≥1000）。 |
| `authFile` | `$DSH_PROFILE_DIR/plugin-data/dsh-zotero/auth.json` | 写权限 key 的落盘位置。 |

## 六、边界与限制

- 只连**本地** Zotero（`127.0.0.1:23119`），不经过 zotero.org 同步。
- 只操作**个人库**（userID 0），不碰群组库。
- 不下载 PDF，也不改写已有附件；`zotero_attach` 只把本机文件**上传**进 storage，`zotero_fulltext` 读的是 Zotero 已建索引的文本（没索引时返回提示而不是报错）。
- Zotero 的全文索引是后台批处理：默认只在它空闲（约 30 秒无操作）或下次启动时补齐。插件在上传后会顺手唤醒一次索引队列（保存一条临时笔记再删掉，借 Zotero 保存笔记时注册队列定时器的行为），所以新挂的文件几秒内就能读全文；想确保索引完成再继续，用 `zotero_attach` 的 `wait: true`。若仍长时间 404，在 Zotero 里右键附件 → 重建索引。
- 批注由你在 Zotero 里画，插件只负责读；写操作不会新建批注。
- “相关论文/参考文献/被引”来自 OpenAlex，无 key 时每日额度共享；大规模批量检索建议自行配 OpenAlex key（插件不强制）。
- 外部检索的年份上限、条目字段都在代码里按 Zotero item type 白名单过滤，未知字段不会写进库。

## 七、排障

| 现象 | 原因与处理 |
| --- | --- |
| `NOT USABLE` / 403 `Local API is not enabled` | Zotero 没开，或高级面板里的本地 API 勾选没开。 |
| 428 / 412 | 版本冲突：条目在你读它之后被改过。重新 `zotero_get` 再改即可（插件在 patch 时会先取最新 version）。 |
| 401 + 弹框 | 缓存 key 失效，插件会自动重新申请一次；若 Zotero 弹框被你拒绝，会返回 `denied`。 |
| `zotero_annotations` 返回 0 条 | Zotero 还没导入该 PDF 的批注，或这篇论文没有 PDF 附件。 |
| 全文返回「未索引」 | Zotero 尚未为该 PDF 建全文索引。先重试一次（索引进度以秒计）；仍不行就在 Zotero 里右键附件 → 重建索引。 |

## 八、开源与市场收录

- 源码与发布：<https://github.com/kuangdang123/dsh-zotero>，版本标签见 Releases（最新 `v0.1.3`）。
- 社区目录：已向 `awesome-dsh-plugin/awesome-dsh-plugin` 提交条目
  `data/plugins/kuangdang123__dsh-zotero.yml`（PR #13777）。
  合并后目录会以 format-1 索引发布（`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`），
  dshmarket（dshmarket.com）以及任何订阅该索引的 DSH 都能直接装到。
- 本仓库也自带一份 format-1 索引 `market/index.json`（`npm run index` 生成，每次发版重新固定 commit），
  DSH 的「插件 → 发现」里添加 `https://raw.githubusercontent.com/kuangdang123/dsh-zotero/main/market/index.json` 即可。
- 目录条目的门禁：仓库要声明 `dsh.bundle`、创建满 1 天、带 `dsh-plugin` topic；
  图标只接受 GitHub 托管的 png/jpg/webp，`icon.png` 由 `npm run icon` 从 `icon.svg` 生成（零依赖渲染）。

## 九、开发

```sh
node --test tests/tools.test.mjs
```

测试用 `tests/fake-zotero.mjs` 起一个假的本地 API（复刻 server-id 校验、写 key 鉴权、版本冲突、回收站、`deleted: true` 等语义），不依赖真实 Zotero。