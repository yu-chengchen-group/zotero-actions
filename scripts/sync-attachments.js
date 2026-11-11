// 菜单名称：同步附件。新版协议：一篇文献可以对应任意数量的源文件及其 Markdown。
const API_URL = "https://api.chen-group.cn/v1/attachments";
const DOCUMENT2MD_KEY = "1786529156738-JlgQvNK5";
const TEACHER_KEY = Services.env.get("CHEN_GROUP_API_KEY");
const MEMBER_KEY = Services.env.get("CHEN_GROUP_API_KEY_MEMBER");
const API_KEY = TEACHER_KEY || MEMBER_KEY;
const IS_PUBLISHER = Boolean(TEACHER_KEY);
const CACHE_KEY_PREFIX = "chen:";
const CACHE_KEY_PATTERN = /^chen:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_TAG = "@chen-source:";
const MD_TAG = "@chen-md:";
const SOURCE_BASE_TAG = "@chen-source-sha:";
const BUNDLE_BASE_TAG = "@chen-bundle-sha:";
const SOURCE_HASH_PATTERN = /^<!-- document2md-source-sha256: ([0-9a-f]{64}) -->$/;
const FIG_PATTERN = /_fig_\d{3,}\.(?:bmp|jpeg|jpg|png|tif|tiff|webp)$/i;
const CONVERT_EXTENSIONS = new Set([
    ".pdf", ".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp",
    ".csv", ".docx", ".html", ".htm", ".pptx", ".xlsx",
]);
const POLL_INTERVAL_MS = 2000;
const MEMBER_CONCURRENCY = 8;
let document2mdTail = Promise.resolve();

function invocationItems() {
    if (typeof items !== "undefined" && Array.isArray(items) && items.length) {
        return items;
    }
    return typeof item !== "undefined" && item ? [item] : [];
}

function isPersonal(item) {
    return item.libraryID === Zotero.Libraries.userLibraryID;
}

function parentOf(value) {
    if (value && value.isRegularItem()) {
        return value;
    }
    if (value && value.isAttachment() && value.parentID) {
        const parent = Zotero.Items.get(value.parentID);
        return parent && parent.isRegularItem() ? parent : null;
    }
    return null;
}

function addScope(scopes, value) {
    const parent = parentOf(value);
    if (!parent || parent.deleted) {
        return;
    }
    if (!isPersonal(parent)) {
        throw new Error("只允许同步“我的文库”中的文献");
    }
    if (!scopes.has(parent.id)) {
        scopes.set(parent.id, { literature: parent, all: false, selected: new Set() });
    }
    const scope = scopes.get(parent.id);
    if (value.isRegularItem()) {
        scope.all = true;
        scope.selected.clear();
    }
    else if (!scope.all) {
        scope.selected.add(value.id);
    }
}

function addCollection(scopes, collection) {
    if (!isPersonal(collection)) {
        throw new Error("只允许选择“我的文库”中的 Collection");
    }
    for (const value of collection.getChildItems(false, false)) {
        addScope(scopes, value);
    }
    for (const child of Zotero.Collections.getByParent(collection.id, false)) {
        addCollection(scopes, child);
    }
}

async function resolveScopes() {
    const scopes = new Map();
    if (typeof collection !== "undefined" && collection) {
        addCollection(scopes, collection);
    }
    else {
        const selected = invocationItems();
        if (selected.length) {
            for (const value of selected) {
                addScope(scopes, value);
            }
        }
        else if (!IS_PUBLISHER) {
            const pane = Zotero.getActiveZoteroPane();
            if (!pane || pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
                throw new Error("必须进入“我的文库”");
            }
            for (const value of await Zotero.Items.getAll(
                Zotero.Libraries.userLibraryID, false, false, false
            )) {
                addScope(scopes, value);
            }
        }
        else {
            throw new Error("教师发布必须明确选中文献或 Collection");
        }
    }
    return [...scopes.values()];
}

function normalizeDOI(value) {
    let doi = String(value || "").trim()
        .replace(/^doi:\s*/i, "")
        .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : "";
}

function cacheKeyFromExtra(literature) {
    const match = String(literature.getField("extra") || "")
        .match(/^Cache-Key:\s*(\S+)\s*$/im);
    if (!match) {
        return "";
    }
    if (!CACHE_KEY_PATTERN.test(match[1])) {
        throw new Error("Extra 中 Cache-Key 格式无效");
    }
    return match[1].toLowerCase();
}

async function literatureIdentity(literature) {
    const doi = normalizeDOI(literature.getField("DOI"));
    if (doi) {
        return { type: "doi", value: doi };
    }
    let key = cacheKeyFromExtra(literature);
    if (!key) {
        if (!IS_PUBLISHER) {
            throw new Error("文献没有 DOI 或群组共享 Cache-Key，学生不能自行生成共享标识");
        }
        const uuid = Services.uuid.generateUUID().toString().replace(/[{}]/g, "").toLowerCase();
        key = `${CACHE_KEY_PREFIX}${uuid}`;
        const extra = String(literature.getField("extra") || "");
        literature.setField("extra", `${extra}${extra && !/\r?\n$/.test(extra) ? "\n" : ""}Cache-Key: ${key}`);
        await literature.saveTx();
    }
    return { type: "cache_key", value: key };
}

function query(identity) {
    return `${identity.type}=${encodeURIComponent(identity.value)}`;
}

function filenameOf(attachment) {
    return attachment.attachmentFilename || attachment.getField("title")
        || `attachment-${attachment.id}`;
}

function extensionOf(name) {
    const index = name.lastIndexOf(".");
    return index === -1 ? "" : name.slice(index).toLowerCase();
}

function isSource(attachment) {
    if (!attachment || !attachment.isAttachment() || attachment.deleted
        || attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
        return false;
    }
    const filename = filenameOf(attachment);
    return !!filename && extensionOf(filename) !== ".md" && !FIG_PATTERN.test(filename);
}

function sourceItems(literature, selected = null) {
    return literature.getAttachments()
        .map(id => Zotero.Items.get(id))
        .filter(a => isSource(a) && (selected === null || selected.has(a.id)))
        .sort((a, b) => filenameOf(a).localeCompare(filenameOf(b), undefined, { numeric: true }));
}

function tagID(attachment, prefix) {
    const hit = attachment.getTags().find(tag =>
        tag.tag.startsWith(prefix) && /^[A-Z0-9]{8}$/.test(tag.tag.slice(prefix.length))
    );
    return hit ? hit.tag.slice(prefix.length) : "";
}

async function setManagedTag(attachment, prefix, id) {
    const expected = `${prefix}${id}`;
    let dirty = false;
    for (const entry of attachment.getTags()) {
        if (entry.tag.startsWith(prefix) && entry.tag !== expected) {
            attachment.removeTag(entry.tag);
            dirty = true;
        }
    }
    if (!attachment.getTags().some(entry => entry.tag === expected)) {
        attachment.addTag(expected);
        dirty = true;
    }
    if (dirty) {
        await attachment.saveTx();
    }
}

function trackedHash(attachment, prefix) {
    const entry = attachment.getTags().find(value =>
        value.tag.startsWith(prefix) && /^[0-9a-f]{64}$/.test(value.tag.slice(prefix.length))
    );
    return entry ? entry.tag.slice(prefix.length) : "";
}

async function setTrackedHash(attachment, prefix, digest) {
    const expected = `${prefix}${digest}`;
    let changed = false;
    for (const entry of attachment.getTags()) {
        if (entry.tag.startsWith(prefix) && entry.tag !== expected) {
            attachment.removeTag(entry.tag);
            changed = true;
        }
    }
    if (!attachment.getTags().some(value => value.tag === expected)) {
        attachment.addTag(expected);
        changed = true;
    }
    if (changed) {
        await attachment.saveTx();
    }
}

function nsFile(path) {
    const file = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);
    file.initWithPath(path);
    return file;
}

function sha256File(path) {
    const hash = Components.classes["@mozilla.org/security/hash;1"]
        .createInstance(Components.interfaces.nsICryptoHash);
    const stream = Components.classes["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Components.interfaces.nsIFileInputStream);
    stream.init(nsFile(path), 0x01, 0, 0);
    try {
        hash.init(Components.interfaces.nsICryptoHash.SHA256);
        hash.updateFromStream(stream, -1);
        return Array.from(hash.finish(false), c =>
            c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    }
    finally {
        stream.close();
    }
}

async function sourceInfo(attachment) {
    const path = await attachment.getFilePathAsync();
    if (!path || !await IOUtils.exists(path)) {
        return null;
    }
    return {
        attachment,
        id: tagID(attachment, SOURCE_TAG) || attachment.key,
        filename: filenameOf(attachment),
        content_type: attachment.attachmentContentType || "application/octet-stream",
        path,
        sha256: sha256File(path),
    };
}

function isGeneratedMD(attachment) {
    return attachment && attachment.isAttachment()
        && extensionOf(filenameOf(attachment)) === ".md"
        && attachment.attachmentContentType === "text/markdown"
        && attachment.getField("title") === "Markdown";
}

function matchingMD(literature, source, id) {
    const all = literature.getAttachments()
        .map(key => Zotero.Items.get(key))
        .filter(isGeneratedMD);
    const tagged = all.filter(a => tagID(a, MD_TAG) === id);
    if (tagged.length > 1) {
        throw new Error(`Markdown 附件标识重复：${id}`);
    }
    if (tagged.length) {
        return tagged[0];
    }
    const sameName = all.filter(a =>
        filenameOf(a).toLowerCase() === `${filenameOf(source)}.md`.toLowerCase()
    );
    return sameName.length === 1 ? sameName[0] : null;
}

async function mdMatchesSource(markdown, sha256) {
    if (!markdown || !isGeneratedMD(markdown)) {
        return false;
    }
    const path = await markdown.getFilePathAsync();
    if (!path || !await IOUtils.exists(path)) {
        return false;
    }
    const firstLine = String(await Zotero.File.getContentsAsync(path, "utf-8"))
        .split(/\r?\n/, 1)[0];
    const match = firstLine.match(SOURCE_HASH_PATTERN);
    return !!match && match[1] === sha256;
}

function requestHeaders(extra = {}) {
    return { Authorization: `Bearer ${API_KEY}`, ...extra };
}

async function request(method, url, options = {}) {
    for (let attempt = 0; ; attempt++) {
        const response = await Zotero.HTTP.request(method, url, {
            ...options, successCodes: false, timeout: 0,
        });
        if (![429, 503].includes(response.status) || attempt >= 10) {
            if (response.status < 200 || response.status >= 300) {
                const value = response.response;
                const error = value && typeof value === "object"
                    ? value.error || value.detail || "" : "";
                throw new Error(`附件服务 HTTP ${response.status}：${error}`);
            }
            return response;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

async function remoteState(identity, cacheOnly = true) {
    const suffix = cacheOnly ? "&cache_only=1" : "";
    let response = await request("GET", `${API_URL}?${query(identity)}${suffix}`, {
        headers: requestHeaders(), responseType: "json",
    });
    let state = response.response;
    while (state.discovery && state.discovery.status === "searching") {
        const jobID = state.discovery.job_id;
        if (!jobID) {
            throw new Error("全文检索缺少 job_id");
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        response = await request(
            "GET",
            `${API_URL}?${query(identity)}&job_id=${encodeURIComponent(jobID)}`,
            { headers: requestHeaders(), responseType: "json" }
        );
        state = response.response;
    }
    if (!Array.isArray(state.attachments) || !state.discovery) {
        throw new Error("服务器附件清单格式无效");
    }
    return state;
}

async function upload(identity, kind, attachmentID, path, mime, filename) {
    const bytes = await IOUtils.read(path);
    const suffix = attachmentID ? `&attachment_id=${attachmentID}` : "";
    const headers = requestHeaders({ "Content-Type": mime });
    if (filename) {
        headers["X-Filename"] = encodeURIComponent(filename);
    }
    const response = await request(
        "PUT", `${API_URL}?${query(identity)}&kind=${kind}${suffix}`,
        { headers, body: bytes, responseType: "json" }
    );
    return response.response;
}

async function publishManifest(identity, attachments) {
    await request("PUT", `${API_URL}?${query(identity)}&kind=manifest`, {
        headers: requestHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ attachments }),
        responseType: "json",
    });
}

async function download(identity, id, kind) {
    const response = await request(
        "GET", `${API_URL}?${query(identity)}&attachment_id=${id}&download=${kind}`,
        { headers: requestHeaders(), responseType: "arraybuffer" }
    );
    return response.response;
}

function cleanupTemp(directory) {
    try {
        if (directory && directory.exists()) {
            directory.remove(true);
        }
    }
    catch (error) {
        Zotero.logError(error);
    }
}

async function importBinary(literature, name, mime, bytes) {
    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const file = Zotero.File.pathToFile(directory.path);
    file.append(name);
    try {
        await Zotero.File.putContentsAsync(file.path, new Blob([bytes]));
        const result = await Zotero.Attachments.importFromFile({
            file: file.path, parentItemID: literature.id,
            title: name, contentType: mime,
        });
        if (Zotero.FullText) {
            await Zotero.FullText.queueItem(result);
        }
        return result;
    }
    finally {
        cleanupTemp(directory);
    }
}

async function importSource(literature, record, bytes) {
    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const file = Zotero.File.pathToFile(directory.path);
    file.append(record.filename);
    try {
        await Zotero.File.putContentsAsync(file.path, new Blob([bytes]));
        if (sha256File(file.path) !== record.sha256) {
            throw new Error(`服务器源文件 SHA-256 不匹配：${record.filename}`);
        }
        const result = await Zotero.Attachments.importFromFile({
            file: file.path, parentItemID: literature.id,
            title: record.filename, contentType: record.content_type,
        });
        await setManagedTag(result, SOURCE_TAG, record.id);
        await setTrackedHash(result, SOURCE_BASE_TAG, record.sha256);
        if (Zotero.FullText) {
            await Zotero.FullText.queueItem(result);
        }
        return result;
    }
    finally {
        cleanupTemp(directory);
    }
}

async function replaceUnmodifiedSource(attachment, record, bytes) {
    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const file = Zotero.File.pathToFile(directory.path);
    file.append(record.filename);
    try {
        await Zotero.File.putContentsAsync(file.path, new Blob([bytes]));
        if (sha256File(file.path) !== record.sha256) {
            throw new Error(`服务器源文件校验失败：${record.filename}`);
        }
        const target = await attachment.getFilePathAsync();
        if (!target || !await IOUtils.exists(target)) {
            throw new Error("本地附件路径不可用");
        }
        await Zotero.File.putContentsAsync(target, new Blob([bytes]));
        await setTrackedHash(attachment, SOURCE_BASE_TAG, record.sha256);
        if (Zotero.FullText) {
            await Zotero.FullText.queueItem(attachment);
        }
    }
    finally {
        cleanupTemp(directory);
    }
}

function convertSupported(source) {
    return CONVERT_EXTENSIONS.has(extensionOf(filenameOf(source)));
}

async function convertSource(source) {
    const current = document2mdTail.then(() =>
        Zotero.ActionsTags.api.actionManager.dispatchActionByKey(
            DOCUMENT2MD_KEY, { itemIDs: [source.id] }
        )
    );
    document2mdTail = current.catch(() => {});
    await current;
}

async function ensureMD(literature, source, digest, id, convertIfMissing) {
    const existing = matchingMD(literature, source, id);
    if (existing && await mdMatchesSource(existing, digest)) {
        await setManagedTag(existing, MD_TAG, id);
        return existing;
    }
    if (!convertIfMissing || !convertSupported(source)) {
        return null;
    }
    await convertSource(source);
    const generated = matchingMD(literature, source, id);
    if (!generated || !await mdMatchesSource(generated, digest)) {
        throw new Error(`转换未生成有效 Markdown：${filenameOf(source)}`);
    }
    await setManagedTag(generated, MD_TAG, id);
    return generated;
}

async function createBundle(markdown, id, sourceSHA) {
    const mdPath = await markdown.getFilePathAsync();
    if (!mdPath || !await IOUtils.exists(mdPath)) {
        throw new Error("Markdown 文件不存在");
    }
    const temp = await Zotero.Attachments.createTemporaryStorageDirectory();
    const meta = Zotero.File.pathToFile(temp.path);
    meta.append("provenance.json");
    const zip = Zotero.File.pathToFile(temp.path);
    zip.append("markdown.zip");
    await Zotero.File.putContentsAsync(meta.path, JSON.stringify({
        attachment_id: id, source_sha256: sourceSHA,
    }), "utf-8");
    const writer = Components.classes["@mozilla.org/zipwriter;1"]
        .createInstance(Components.interfaces.nsIZipWriter);
    try {
        writer.open(zip, 0x04 | 0x08 | 0x20);
        writer.addEntryFile("provenance.json", writer.COMPRESSION_DEFAULT, meta, false);
        const mdFile = nsFile(mdPath);
        writer.addEntryFile(mdFile.leafName, writer.COMPRESSION_DEFAULT, mdFile, false);
        const storage = Zotero.Attachments.getStorageDirectory(markdown);
        for (const path of await IOUtils.getChildren(storage.path)) {
            const file = nsFile(path);
            if (!file.isFile() || !FIG_PATTERN.test(file.leafName)) {
                continue;
            }
            writer.addEntryFile(file.leafName, writer.COMPRESSION_DEFAULT, file, false);
        }
    }
    catch (error) {
        cleanupTemp(temp);
        throw error;
    }
    finally {
        try { writer.close(); } catch (error) { Zotero.logError(error); }
    }
    return { directory: temp, path: zip.path, sha256: sha256File(zip.path) };
}

async function importBundle(literature, record, bytes) {
    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const zipFile = Zotero.File.pathToFile(directory.path);
    zipFile.append("bundle.zip");
    try {
        await Zotero.File.putContentsAsync(zipFile.path, new Blob([bytes]));
        if (sha256File(zipFile.path) !== record.bundle_sha256) {
            throw new Error(`服务器 Markdown ZIP 哈希不匹配：${record.filename}`);
        }
        const reader = Components.classes["@mozilla.org/libjar/zip-reader;1"]
            .createInstance(Components.interfaces.nsIZipReader);
        const extracted = [];
        try {
            reader.open(zipFile);
            const iterator = reader.findEntries("*");
            while (iterator.hasMore()) {
                const name = iterator.getNext();
                if (!name || /[\\/]/.test(name) || reader.getEntry(name).isDirectory) {
                    throw new Error("ZIP 包含非法文件路径");
                }
                const output = Zotero.File.pathToFile(directory.path);
                output.append(name);
                reader.extract(name, output);
                extracted.push(output.path);
            }
        }
        finally {
            reader.close();
        }
        const metadata = extracted.find(path => path.endsWith("provenance.json"));
        if (!metadata) {
            throw new Error("ZIP 缺少 provenance.json");
        }
        const provenance = JSON.parse(await Zotero.File.getContentsAsync(metadata, "utf-8"));
        if (provenance.attachment_id !== record.id || provenance.source_sha256 !== record.sha256) {
            throw new Error("ZIP 与源附件不匹配");
        }
        const candidates = extracted.filter(path => /\.md$/i.test(path));
        if (candidates.length !== 1) {
            throw new Error("ZIP Markdown 数量异常");
        }
        const md = await Zotero.Attachments.importFromFile({
            file: candidates[0], parentItemID: literature.id,
            title: "Markdown", contentType: "text/markdown",
        });
        try {
            const storage = Zotero.Attachments.getStorageDirectory(md);
            for (const path of extracted) {
                const name = path.split(/[\\/]/).pop();
                if (FIG_PATTERN.test(name)) {
                    nsFile(path).copyToFollowingLinks(storage, name);
                }
            }
            if (!await mdMatchesSource(md, record.sha256)) {
                throw new Error("下载的 Markdown 来源标记无效");
            }
            await setManagedTag(md, MD_TAG, record.id);
            await setTrackedHash(md, BUNDLE_BASE_TAG, record.bundle_sha256);
            if (Zotero.FullText) {
                await Zotero.FullText.queueItem(md);
            }
            await Zotero.Sync.Storage.Local.updateSyncStates([md], "to_upload");
        }
        catch (error) {
            await Zotero.Items.erase([md.id]);
            throw error;
        }
        return md;
    }
    finally {
        cleanupTemp(directory);
    }
}

async function maybeDiscover(literature, identity, sourceList, remote, warnings) {
    if (remote.attachments.length || sourceList.length || identity.type !== "doi") {
        return sourceList;
    }
    const result = await remoteState(identity, false);
    if (result.discovery.status === "manual") {
        warnings.push(`需人工获取 PDF：${result.discovery.url || identity.value}`);
        return sourceList;
    }
    if (result.discovery.status !== "cached") {
        warnings.push(`全文检索：${result.discovery.status}`);
        return sourceList;
    }
    const response = await request("GET", result.discovery.url, {
        responseType: "arraybuffer",
    });
    const local = await importBinary(literature, "article.pdf", "application/pdf", response.response);
    sourceList.push(local);
    return sourceList;
}

async function publishScope(scope, warnings) {
    const identity = await literatureIdentity(scope.literature);
    const remote = await remoteState(identity);
    let sources = sourceItems(scope.literature, scope.all ? null : scope.selected);
    sources = await maybeDiscover(scope.literature, identity, sources, remote, warnings);
    const published = new Map(remote.attachments.map(entry => [entry.id, entry]));
    // 附件在本地删除或未下载时，不自动从共享缓存删除。
    const proposed = new Map(published);
    if (!sources.length) {
        warnings.push("没有可发布的本地附件，云端原有附件保持不变");
        return { updated: 0 };
    }

    for (const source of sources) {
        const info = await sourceInfo(source);
        if (!info) {
            warnings.push(`文件未下载：${filenameOf(source)}`);
            continue;
        }
        const id = info.id;
        if (!/^[A-Z0-9]{8}$/.test(id)) {
            throw new Error(`附件 Key 无效：${id}`);
        }
        await setManagedTag(source, SOURCE_TAG, id);
        let markdown = null;
        if (convertSupported(source)) {
            try {
                markdown = await ensureMD(scope.literature, source, info.sha256, id, true);
            }
            catch (error) {
                warnings.push(`${info.filename}：${error.message || error}`);
            }
        }
        const old = published.get(id);
        if (!old || old.sha256 !== info.sha256) {
            await upload(identity, "source", id, info.path, info.content_type, info.filename);
        }
        let bundleSHA = null;
        if (markdown) {
            const bundle = await createBundle(markdown, id, info.sha256);
            try {
                bundleSHA = bundle.sha256;
                if (!old || old.bundle_sha256 !== bundleSHA) {
                    await upload(identity, "bundle", id, bundle.path, "application/zip");
                }
            }
            finally {
                cleanupTemp(bundle.directory);
            }
        }
        else if (old && old.sha256 === info.sha256) {
            bundleSHA = old.bundle_sha256;
        }
        proposed.set(id, {
            id, filename: info.filename, content_type: info.content_type,
            sha256: info.sha256, size: (await IOUtils.stat(info.path)).size,
            bundle_sha256: bundleSHA,
        });
    }
    await publishManifest(identity, [...proposed.values()]);
    return { updated: sources.length };
}

async function localMatch(literature, record, candidates) {
    const exact = candidates.filter(source => tagID(source, SOURCE_TAG) === record.id);
    if (exact.length > 1) {
        throw new Error(`云端附件 ID 本地重复：${record.id}`);
    }
    if (exact.length) {
        return exact[0];
    }
    const same = [];
    for (const source of candidates) {
        if (tagID(source, SOURCE_TAG)) {
            continue;
        }
        const info = await sourceInfo(source);
        if (info && info.sha256 === record.sha256) {
            same.push(source);
        }
    }
    const named = same.filter(source =>
        filenameOf(source).toLowerCase() === record.filename.toLowerCase()
    );
    const chosen = named.length === 1 ? named[0] : same.length === 1 ? same[0] : null;
    if (chosen) {
        await setManagedTag(chosen, SOURCE_TAG, record.id);
        await setTrackedHash(chosen, SOURCE_BASE_TAG, record.sha256);
        return chosen;
    }
    return null;
}

async function consumeScope(scope, warnings) {
    const identity = await literatureIdentity(scope.literature);
    const remote = await remoteState(identity);
    let local = sourceItems(scope.literature);
    if (!remote.attachments.length) {
        local = await maybeDiscover(scope.literature, identity, local, remote, warnings);
    }
    let count = 0;
    for (const record of remote.attachments) {
        let attachment = await localMatch(scope.literature, record, local);
        if (!scope.all && scope.selected.size) {
            if (!attachment || !scope.selected.has(attachment.id)) {
                continue;
            }
        }
        if (!attachment) {
            const bytes = await download(identity, record.id, "source");
            attachment = await importSource(scope.literature, record, bytes);
            local.push(attachment);
            count++;
        }
        let info = await sourceInfo(attachment);
        if (!info) {
            warnings.push(`本地附件不可用：${record.filename}`);
            continue;
        }
        if (info.sha256 !== record.sha256) {
            const baseline = trackedHash(attachment, SOURCE_BASE_TAG);
            const annotations = typeof attachment.getAnnotations === "function"
                ? attachment.getAnnotations() : [];
            const linkedFile = typeof Zotero.Attachments.LINK_MODE_LINKED_FILE === "number"
                && attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE;
            if (!baseline || baseline !== info.sha256 || linkedFile || annotations.length) {
                warnings.push(`本地附件有修改或批注，保留原文件：${record.filename}`);
                continue;
            }
            await replaceUnmodifiedSource(
                attachment, record, await download(identity, record.id, "source")
            );
            info = await sourceInfo(attachment);
            count++;
        }
        if (!trackedHash(attachment, SOURCE_BASE_TAG)) {
            await setTrackedHash(attachment, SOURCE_BASE_TAG, record.sha256);
        }
        let md = matchingMD(scope.literature, attachment, record.id);
        const mdCurrent = md && await mdMatchesSource(md, record.sha256);
        const previousBundle = md ? trackedHash(md, BUNDLE_BASE_TAG) : "";
        if (mdCurrent && (!previousBundle || previousBundle === record.bundle_sha256)) {
            await setManagedTag(md, MD_TAG, record.id);
            continue;
        }
        if (md) {
            if (previousBundle && record.bundle_sha256) {
                // 完整验证和导入新版本后才删除旧的受管理 Markdown。
                await importBundle(
                    scope.literature, record, await download(identity, record.id, "bundle")
                );
                await Zotero.Items.erase([md.id]);
                count++;
                continue;
            }
            if (!record.bundle_sha256 && convertSupported(attachment)) {
                // 服务器未发布 MD 时本地重新转换；失败仍保留先前的 MD。
                try {
                    await ensureMD(scope.literature, attachment, record.sha256, record.id, true);
                    count++;
                }
                catch (error) {
                    warnings.push(`${record.filename}：${error.message || error}`);
                }
                continue;
            }
            warnings.push(`本地 Markdown 不匹配，保留原文件：${record.filename}`);
            continue;
        }
        if (record.bundle_sha256) {
            const bytes = await download(identity, record.id, "bundle");
            await importBundle(scope.literature, record, bytes);
            count++;
        }
    }
    const selected = scope.all ? local : local.filter(value => scope.selected.has(value.id));
    for (const attachment of selected) {
        const info = await sourceInfo(attachment);
        if (!info || !convertSupported(attachment)) {
            continue;
        }
        const id = info.id;
        const cloud = remote.attachments.find(entry => entry.id === id);
        if (cloud && cloud.sha256 !== info.sha256) {
            continue;
        }
        try {
            const previous = matchingMD(scope.literature, attachment, id);
            if (!previous) {
                await ensureMD(scope.literature, attachment, info.sha256, id, true);
                count++;
            }
            else if (!await mdMatchesSource(previous, info.sha256)) {
                warnings.push(`Markdown 来源不匹配，需人工核对：${info.filename}`);
            }
        }
        catch (error) {
            warnings.push(`${info.filename}：${error.message || error}`);
        }
    }
    return { updated: count };
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

let activeBatch = null;

function createBatchProgress() {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline(IS_PUBLISHER ? "发布附件 · 准备中" : "同步附件 · 准备中");
    const statusLine = new progress.ItemProgress(null, "正在检查选择范围");
    const titleLine = new progress.ItemProgress(null, "");
    statusLine.setProgress(0);
    progress.show();
    return { progress, statusLine, titleLine, total: 0, completed: 0, active: 0 };
}

function updateBatchProgress(batch, detail = "") {
    const { total, completed, active } = batch;
    const heading = IS_PUBLISHER ? "发布附件" : "同步附件";
    batch.progress.changeHeadline(`${heading} ${completed}/${total}`);
    batch.statusLine.setProgress(total ? Math.floor(completed * 100 / total) : 0);
    batch.statusLine.setText(`已处理 ${completed}/${total} · ${active} 项处理中`);
    batch.titleLine.setText(detail);
}

function showSummary(batch, summary) {
    const { progress, statusLine, titleLine } = batch;
    progress.changeHeadline(IS_PUBLISHER ? "发布附件" : "同步附件");
    statusLine.setProgress(100);
    statusLine.setText("处理完成");
    titleLine.setText(
        `文献 ${summary.total}｜附件更新 ${summary.updated}｜失败 ${summary.failed}｜提醒 ${summary.issues.length}`
    );
    for (const issue of summary.issues) {
        progress.addDescription(escapeHtml(issue));
    }
    if (!summary.issues.length) {
        progress.startCloseTimer(5000);
    }
}

(async () => {
    if (!API_KEY) {
        throw new Error("缺少 CHEN_GROUP_API_KEY 或 CHEN_GROUP_API_KEY_MEMBER");
    }
    const batch = createBatchProgress();
    activeBatch = batch;
    const scopes = await resolveScopes();
    if (!scopes.length) {
        throw new Error("没有可同步的文献");
    }
    const summary = { total: scopes.length, updated: 0, failed: 0, issues: [] };
    batch.total = scopes.length;
    updateBatchProgress(batch, "准备同步");
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const index = nextIndex++;
            if (index >= scopes.length) {
                return;
            }
            const scope = scopes[index];
            const warnings = [];
            const title = scope.literature.getField("title") || scope.literature.key;
            batch.active++;
            updateBatchProgress(batch, `处理中 · ${title}`);
            try {
                const result = IS_PUBLISHER
                    ? await publishScope(scope, warnings)
                    : await consumeScope(scope, warnings);
                summary.updated += result.updated;
            }
            catch (error) {
                summary.failed++;
                warnings.push(error.message || String(error));
                Zotero.logError(error);
            }
            finally {
                for (const warning of warnings) {
                    summary.issues.push(`${title}｜${warning}`);
                }
                batch.active--;
                batch.completed++;
                updateBatchProgress(batch, `已处理 · ${title}`);
            }
        }
    }
    await Promise.all(Array.from(
        { length: IS_PUBLISHER ? 1 : Math.min(MEMBER_CONCURRENCY, scopes.length) },
        worker
    ));
    await document2mdTail;
    showSummary(batch, summary);
    activeBatch = null;
})().catch(error => {
    Zotero.logError(error);
    const progress = activeBatch ? activeBatch.progress : new Zotero.ProgressWindow();
    progress.changeHeadline(`${IS_PUBLISHER ? "发布附件" : "同步附件"}失败`);
    if (activeBatch) {
        activeBatch.statusLine.setText("执行中断");
        activeBatch.titleLine.setText(error.message || String(error));
    }
    progress.addDescription(escapeHtml(error.message || String(error)));
    if (!activeBatch) {
        progress.show();
    }
    activeBatch = null;
});
