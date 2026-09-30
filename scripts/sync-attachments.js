// 菜单名称：同步附件
const ATTACHMENTS_API = "https://api.chen-group.cn/v1/attachments";
const DOCUMENT2MD_ACTION_KEY = "1786529156738-JlgQvNK5";
const TEACHER_KEY = Services.env.get("CHEN_GROUP_API_KEY");
const MEMBER_KEY = Services.env.get("CHEN_GROUP_API_KEY_MEMBER");
const API_KEY = TEACHER_KEY || MEMBER_KEY;
const IS_PUBLISHER = Boolean(TEACHER_KEY);
const IMAGE_EXTENSIONS = "bmp|jpeg|jpg|png|tif|tiff|webp";
const GENERATED_FIG_PATTERN = new RegExp(`_fig_\\d{3,}\\.(?:${IMAGE_EXTENSIONS})$`, "i");
const MD_STATUSES = ["@md-处理中", "@md-已生成", "@md-跳过", "@md-失败"];
const SYNC_CONCURRENCY = 8;
const ATTACHMENTS_POLL_INTERVAL_MS = 2000;
const RETRYABLE_HTTP_STATUSES = new Set([0, 429, 503]);
const HTTP_RETRY_DELAY_MS = 500;
const HTTP_RETRY_LIMIT = 10;
const CACHE_KEY_PREFIX = "chen:";
const CACHE_KEY_PATTERN = /^chen:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_PDF_SHA256_PATTERN = /^<!-- document2md-source-pdf-sha256: ([0-9a-f]{64}) -->$/;


function getInvocationItems() {
    if (typeof items !== "undefined" && Array.isArray(items) && items.length) {
        return items;
    }
    if (typeof item !== "undefined" && item) {
        return [item];
    }
    return [];
}


function hasExplicitScope() {
    return Boolean(
        (typeof collection !== "undefined" && collection)
        || getInvocationItems().length
    );
}


function parentLiterature(value) {
    if (value && value.isRegularItem()) {
        return value;
    }
    if (value && value.isAttachment() && value.parentID) {
        const parent = Zotero.Items.get(value.parentID);
        return parent && parent.isRegularItem() ? parent : null;
    }
    return null;
}


function addLiterature(map, value) {
    const literature = parentLiterature(value);
    if (literature && !literature.deleted) {
        map.set(literature.id, literature);
    }
}


function collectCollectionLiterature(sourceCollection, result) {
    for (const child of sourceCollection.getChildItems(false, false)) {
        addLiterature(result, child);
    }
    for (const childCollection of Zotero.Collections.getByParent(sourceCollection.id, false)) {
        collectCollectionLiterature(childCollection, result);
    }
}


async function resolveLiterature() {
    const result = new Map();
    if (typeof collection !== "undefined" && collection) {
        if (collection.libraryID !== Zotero.Libraries.userLibraryID) {
            throw new Error("同步附件只允许在“我的文库”中执行");
        }
        collectCollectionLiterature(collection, result);
    }
    else {
        const selected = getInvocationItems();
        if (selected.length) {
            for (const value of selected) {
                addLiterature(result, value);
            }
        }
        else {
            const pane = Zotero.getActiveZoteroPane();
            if (!pane || pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
                throw new Error("同步附件只允许在“我的文库”中执行");
            }
            for (const value of await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, false, false)) {
                addLiterature(result, value);
            }
        }
    }

    for (const literature of result.values()) {
        if (literature.libraryID !== Zotero.Libraries.userLibraryID) {
            throw new Error("同步附件只允许在“我的文库”中执行");
        }
    }
    return [...result.values()];
}


function normalizeDoi(value) {
    let doi = String(value || "").trim();
    doi = doi.replace(/^doi:\s*/i, "");
    doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    return /^10\.\d{4,9}\/\S+$/i.test(doi) ? doi.toLowerCase() : "";
}


function cacheKeyFromExtra(literature) {
    const extra = String(literature.getField("extra") || "");
    const match = extra.match(/^Cache-Key:\s*(\S+)\s*$/im);
    if (!match) {
        return "";
    }
    const key = match[1].toLowerCase();
    if (!CACHE_KEY_PATTERN.test(key)) {
        throw new Error("Extra 中 Cache-Key 格式无效");
    }
    return key;
}


async function ensureCacheKey(literature) {
    const existing = cacheKeyFromExtra(literature);
    if (existing) {
        return existing;
    }
    const uuid = Services.uuid.generateUUID().toString().replace(/[{}]/g, "").toLowerCase();
    const key = `${CACHE_KEY_PREFIX}${uuid}`;
    const extra = String(literature.getField("extra") || "");
    const separator = extra && !/\r?\n$/.test(extra) ? "\n" : "";
    literature.setField("extra", `${extra}${separator}Cache-Key: ${key}`);
    await literature.saveTx();
    return key;
}


async function attachmentIdentity(literature) {
    const doi = normalizeDoi(literature.getField("DOI"));
    if (doi) {
        return { parameter: "doi", value: doi, searchable: true };
    }
    return {
        parameter: "cache_key",
        value: await ensureCacheKey(literature),
        searchable: false,
    };
}


function identityQuery(identity) {
    return `${identity.parameter}=${encodeURIComponent(identity.value)}`;
}


function citationKey(literature) {
    return String(literature.getField("citationKey") || "").trim();
}


function titleOf(literature) {
    return literature.getField("title") || citationKey(literature) || literature.key;
}


function attachmentName(attachment) {
    return attachment.attachmentFilename
        || attachment.getField("title")
        || `attachment-${attachment.id}`;
}


function isPdfAttachment(attachment) {
    return !!(
        attachment
        && attachment.isAttachment()
        && (
            attachment.attachmentContentType === "application/pdf"
            || /\.pdf$/i.test(attachmentName(attachment))
        )
    );
}


async function localPdf(literature) {
    for (const attachmentID of literature.getAttachments()) {
        const attachment = await Zotero.Items.getAsync(attachmentID);
        if (!isPdfAttachment(attachment)) {
            continue;
        }
        const path = await attachment.getFilePathAsync();
        if (path && await IOUtils.exists(path)) {
            return attachment;
        }
    }
    return null;
}


async function localMarkdown(literature, pdfAttachment = null) {
    const expected = pdfAttachment
        ? `${attachmentName(pdfAttachment)}.md`.toLowerCase()
        : "";
    let fallback = null;
    for (const attachmentID of literature.getAttachments()) {
        const attachment = await Zotero.Items.getAsync(attachmentID);
        if (!attachment || !attachment.isAttachment()) {
            continue;
        }
        const name = attachmentName(attachment);
        if (!/\.md$/i.test(name)) {
            continue;
        }
        const path = await attachment.getFilePathAsync();
        if (!path || !await IOUtils.exists(path)) {
            continue;
        }
        if (expected && name.toLowerCase() === expected) {
            return attachment;
        }
        if (!fallback && (
            attachment.attachmentContentType === "text/markdown"
            || attachment.getField("title") === "Markdown"
        )) {
            fallback = attachment;
        }
    }
    return fallback;
}


function authHeaders(extra = {}) {
    return { Authorization: `Bearer ${API_KEY}`, ...extra };
}


async function httpRequest(method, url, options) {
    for (let attempt = 0; ; attempt++) {
        const response = await Zotero.HTTP.request(method, url, options);
        if (
            !RETRYABLE_HTTP_STATUSES.has(response.status)
            || attempt >= HTTP_RETRY_LIMIT
        ) {
            return response;
        }
        await new Promise(resolve => setTimeout(resolve, HTTP_RETRY_DELAY_MS));
    }
}


async function getRemoteState(identity, cacheOnly = false) {
    const cacheOnlyQuery = cacheOnly ? "&cache_only=1" : "";
    let response = await httpRequest(
        "GET",
        `${ATTACHMENTS_API}?${identityQuery(identity)}${cacheOnlyQuery}`,
        {
            headers: authHeaders(),
            responseType: "json",
            successCodes: false,
            timeout: 0,
        }
    );
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`附件服务 HTTP ${response.status}`);
    }
    let payload = response.response;
    while (!cacheOnly && identity.searchable && payload.pdf && payload.pdf.status === "searching") {
        const jobID = payload.pdf.job_id;
        if (!jobID) {
            throw new Error("附件服务未返回全文搜索任务 ID");
        }
        await new Promise(resolve => setTimeout(resolve, ATTACHMENTS_POLL_INTERVAL_MS));
        response = await httpRequest(
            "GET",
            `${ATTACHMENTS_API}?${identityQuery(identity)}&job_id=${encodeURIComponent(jobID)}`,
            {
                headers: authHeaders(),
                responseType: "json",
                successCodes: false,
                timeout: 0,
            }
        );
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`附件服务 HTTP ${response.status}`);
        }
        payload = response.response;
    }
    if (payload.pdf && payload.pdf.status === "failed") {
        throw new Error(payload.pdf.error || "全文搜索失败");
    }
    return payload;
}


function isPdfBuffer(buffer) {
    if (!buffer || buffer.byteLength < 5) {
        return false;
    }
    const bytes = new Uint8Array(buffer, 0, 5);
    return bytes[0] === 0x25
        && bytes[1] === 0x50
        && bytes[2] === 0x44
        && bytes[3] === 0x46
        && bytes[4] === 0x2D;
}


async function downloadPdf(literature, key, url) {
    const response = await httpRequest("GET", url, {
        responseType: "arraybuffer",
        successCodes: false,
        timeout: 0,
    });
    if (response.status < 200 || response.status >= 300 || !isPdfBuffer(response.response)) {
        throw new Error(`PDF 下载失败：HTTP ${response.status}`);
    }

    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const file = Zotero.File.pathToFile(directory.path);
    file.append(`${key}.pdf`);
    try {
        await Zotero.File.putContentsAsync(file.path, new Blob([response.response]));
        return await Zotero.Attachments.importFromFile({
            file: file.path,
            parentItemID: literature.id,
            title: "PDF",
            contentType: "application/pdf",
        });
    }
    finally {
        removeTemporaryDirectory(directory);
    }
}


async function replacePdf(literature, key, url, existing) {
    const response = await httpRequest("GET", url, {
        responseType: "arraybuffer",
        successCodes: false,
        timeout: 0,
    });
    if (response.status < 200 || response.status >= 300 || !isPdfBuffer(response.response)) {
        throw new Error(`PDF 下载失败：HTTP ${response.status}`);
    }
    if (!existing) {
        return downloadPdf(literature, key, url);
    }
    const path = await existing.getFilePathAsync();
    if (!path || !await IOUtils.exists(path)) {
        throw new Error("本地 PDF 文件不存在，无法原位更新");
    }
    await Zotero.File.putContentsAsync(path, new Blob([response.response]));
    if (Zotero.FullText) {
        await Zotero.FullText.queueItem(existing);
    }
    return existing;
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
        return Array.from(
            hash.finish(false),
            character => character.charCodeAt(0).toString(16).padStart(2, "0")
        ).join("");
    }
    finally {
        stream.close();
    }
}


async function markdownSourcePdfSha256(markdown) {
    const path = await markdown.getFilePathAsync();
    if (!path || !await IOUtils.exists(path)) {
        return "";
    }
    const text = await Zotero.File.getContentsAsync(path, "utf-8");
    const firstLine = String(text || "").split(/\r?\n/, 1)[0];
    const match = firstLine.match(SOURCE_PDF_SHA256_PATTERN);
    return match ? match[1] : "";
}


async function markdownMatchesPdf(markdown, pdf) {
    const recorded = await markdownSourcePdfSha256(markdown);
    if (!recorded) {
        return false;
    }
    const path = await pdf.getFilePathAsync();
    if (!path || !await IOUtils.exists(path)) {
        return false;
    }
    return recorded === sha256File(path);
}


function removeTemporaryDirectory(directory) {
    try {
        if (directory && directory.exists()) {
            directory.remove(true);
        }
    }
    catch (error) {
        Zotero.logError(error);
    }
}


async function setMarkdownSuccess(literature) {
    for (const tag of MD_STATUSES) {
        literature.removeTag(tag);
    }
    literature.addTag("@md-已生成");
    await literature.saveTx();
}


async function installBundle(literature, identity, existingMarkdown = null) {
    const response = await httpRequest(
        "GET",
        `${ATTACHMENTS_API}?${identityQuery(identity)}&download=bundle`,
        {
            headers: authHeaders(),
            responseType: "arraybuffer",
            successCodes: false,
            timeout: 0,
        }
    );
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Bundle 下载失败：HTTP ${response.status}`);
    }

    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const zipFile = Zotero.File.pathToFile(directory.path);
    zipFile.append("bundle.zip");
    await Zotero.File.putContentsAsync(zipFile.path, new Blob([response.response]));

    const reader = Components.classes["@mozilla.org/libjar/zip-reader;1"]
        .createInstance(Components.interfaces.nsIZipReader);
    const extracted = [];
    try {
        reader.open(zipFile);
        const entries = reader.findEntries("*");
        while (entries.hasMore()) {
            const name = entries.getNext();
            if (!name || /[\\/]/.test(name) || reader.getEntry(name).isDirectory) {
                continue;
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

    const markdownFiles = extracted.filter(path => /\.md$/i.test(path));
    if (markdownFiles.length !== 1) {
        removeTemporaryDirectory(directory);
        throw new Error("Bundle 中 Markdown 文件数量必须为 1");
    }

    let markdown = null;
    try {
        markdown = await Zotero.Attachments.importFromFile({
            file: markdownFiles[0],
            parentItemID: literature.id,
            title: "Markdown",
            contentType: "text/markdown",
        });
        const storage = Zotero.Attachments.getStorageDirectory(markdown);
        for (const path of extracted) {
            const name = path.split(/[\\/]/).pop();
            if (!GENERATED_FIG_PATTERN.test(name)) {
                continue;
            }
            nsFile(path).copyToFollowingLinks(storage, name);
        }
        if (Zotero.FullText) {
            await Zotero.FullText.queueItem(markdown);
        }
        if (existingMarkdown && existingMarkdown.id !== markdown.id) {
            await Zotero.Items.erase([existingMarkdown.id]);
        }
        await setMarkdownSuccess(literature);
        return markdown;
    }
    catch (error) {
        if (markdown) {
            try {
                await Zotero.Items.erase([markdown.id]);
            }
            catch (cleanupError) {
                Zotero.logError(cleanupError);
            }
        }
        throw error;
    }
    finally {
        removeTemporaryDirectory(directory);
    }
}


async function createBundle(markdown) {
    const markdownPath = await markdown.getFilePathAsync();
    if (!markdownPath || !await IOUtils.exists(markdownPath)) {
        throw new Error("Markdown 本地文件不存在");
    }
    const storage = Zotero.Attachments.getStorageDirectory(markdown);
    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const zipFile = Zotero.File.pathToFile(directory.path);
    zipFile.append("bundle.zip");
    const writer = Components.classes["@mozilla.org/zipwriter;1"]
        .createInstance(Components.interfaces.nsIZipWriter);
    writer.open(zipFile, 0x04 | 0x08 | 0x20);
    try {
        const markdownFile = nsFile(markdownPath);
        writer.addEntryFile(
            markdownFile.leafName,
            writer.COMPRESSION_DEFAULT,
            markdownFile,
            false
        );
        for (const path of await IOUtils.getChildren(storage.path)) {
            const file = nsFile(path);
            if (!file.isFile() || !GENERATED_FIG_PATTERN.test(file.leafName)) {
                continue;
            }
            writer.addEntryFile(
                file.leafName,
                writer.COMPRESSION_DEFAULT,
                file,
                false
            );
        }
    }
    finally {
        writer.close();
    }
    return { directory, path: zipFile.path };
}


async function uploadFile(identity, kind, path, contentType) {
    const body = await IOUtils.read(path);
    const response = await httpRequest(
        "PUT",
        `${ATTACHMENTS_API}?${identityQuery(identity)}&kind=${kind}`,
        {
            headers: authHeaders({ "Content-Type": contentType }),
            body,
            responseType: "json",
            successCodes: false,
            timeout: 0,
        }
    );
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`${kind} 上传失败：HTTP ${response.status}`);
    }
    return response.response;
}


async function runDocument2md(pdf) {
    await Zotero.ActionsTags.api.actionManager.dispatchActionByKey(
        DOCUMENT2MD_ACTION_KEY,
        {
            itemIDs: [pdf.id],
        }
    );
}


function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}


function itemLink(entry) {
    return `<a href="zotero://select/library/items/${entry.item.key}">${escapeHtml(entry.title)}</a>`;
}


function externalLink(url, text = "手动下载 PDF") {
    return `<a href="${escapeHtml(url)}">${text}</a>`;
}


function showFinalSummary(batch, summary) {
    const issueCount = summary.manual.length
        + summary.notFound.length
        + summary.mdOnly.length
        + summary.failed.length;
    const progress = batch.progress;
    progress.changeHeadline(IS_PUBLISHER ? "发布附件" : "同步附件");
    batch.statusLine.setProgress(100);
    batch.statusLine.setText("完成");
    batch.titleLine.setProgress(100);
    batch.titleLine.setText(
        IS_PUBLISHER
            ? `总计 ${summary.total}｜已一致 ${summary.unchanged}｜发布 ${summary.updated}｜失败 ${summary.failed.length}`
            : (
                issueCount
                    ? `总计 ${summary.total}｜已一致 ${summary.unchanged}｜更新 ${summary.updated}｜待审 ${issueCount}`
                    : `总计 ${summary.total}｜已一致 ${summary.unchanged}｜更新 ${summary.updated}`
            )
    );

    for (const entry of summary.manual) {
        progress.addDescription("待人工");
        progress.addDescription(itemLink(entry));
        progress.addDescription(externalLink(entry.url));
    }
    for (const entry of summary.notFound) {
        progress.addDescription("待人工");
        progress.addDescription(itemLink(entry));
        progress.addDescription("未找到全文");
    }
    for (const entry of summary.mdOnly) {
        progress.addDescription("待审");
        progress.addDescription(itemLink(entry));
        progress.addDescription("缺 PDF，已保留 Markdown");
        if (entry.url) {
            progress.addDescription(externalLink(entry.url, "查看全文页面"));
        }
    }
    for (const entry of summary.failed) {
        const error = String(entry.error).replace(/^附件服务\s+/i, "");
        progress.addDescription("失败");
        progress.addDescription(itemLink(entry));
        progress.addDescription(escapeHtml(error));
    }
    if (!issueCount) {
        progress.startCloseTimer(4000);
    }
}


function createBatchProgress(total) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline(`${IS_PUBLISHER ? "发布附件" : "同步附件"} 0/${total}`);
    const statusLine = new progress.ItemProgress(null, "处理中");
    const titleLine = new progress.ItemProgress(null, "");
    statusLine.setProgress(0);
    progress.show();
    return { progress, statusLine, titleLine };
}


function updateBatchProgress(batch, processed, total, status = "处理中", detail = "") {
    const percent = total ? 50 + processed * 50 / total : 100;
    batch.progress.changeHeadline(
        `${IS_PUBLISHER ? "发布附件" : "同步附件"} ${processed}/${total}`
    );
    batch.statusLine.setProgress(percent);
    batch.statusLine.setText(`已处理 ${processed}/${total} · ${status}`);
    batch.titleLine.setText(detail);
}


function updateCheckProgress(batch, checked, total, activeChecks) {
    batch.progress.changeHeadline(
        `${IS_PUBLISHER ? "发布附件" : "同步附件"} 0/${total}`
    );
    batch.statusLine.setProgress(total ? checked * 50 / total : 50);
    batch.statusLine.setText(
        `已检查 ${checked}/${total} · 并发检查服务器 · ${activeChecks} 项处理中`
    );
}


let activeBatch = null;


(async () => {
    if (typeof item !== "undefined" && item) {
        return;
    }
    if (!API_KEY) {
        throw new Error("缺少环境变量 CHEN_GROUP_API_KEY 或 CHEN_GROUP_API_KEY_MEMBER");
    }
    if (IS_PUBLISHER && !hasExplicitScope()) {
        throw new Error("教师发布必须明确选择文献或 Collection，禁止直接发布整个文库");
    }

    const literature = await resolveLiterature();
    if (!literature.length) {
        throw new Error("当前选择中没有可同步的文献条目");
    }

    const summary = {
        total: literature.length,
        updated: 0,
        unchanged: 0,
        manual: [],
        notFound: [],
        mdOnly: [],
        failed: [],
    };
    const batch = createBatchProgress(literature.length);
    activeBatch = batch;
    let processed = 0;
    let document2mdTail = Promise.resolve();

    function finishItem() {
        processed++;
        updateBatchProgress(batch, processed, literature.length);
    }

    function addResult(changed) {
        if (changed) {
            summary.updated++;
        }
        else {
            summary.unchanged++;
        }
    }

    function addFailure(entry, error) {
        summary.failed.push({
            ...entry,
            error: error && error.message ? error.message : String(error),
        });
        Zotero.logError(error);
    }

    function remotePdfSha256(remote) {
        const value = remote && remote.pdf && remote.pdf.source_pdf_sha256;
        return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
            ? value
            : "";
    }

    async function publishAttachments(identity, pdf, markdown, uploadPdf = true) {
        updateBatchProgress(
            batch,
            processed,
            literature.length,
            "处理中 · 发布至服务器"
        );
        if (uploadPdf) {
            const pdfPath = await pdf.getFilePathAsync();
            if (!pdfPath || !await IOUtils.exists(pdfPath)) {
                throw new Error("PDF 本地文件不存在");
            }
            await uploadFile(identity, "pdf", pdfPath, "application/pdf");
        }

        const bundle = await createBundle(markdown);
        try {
            await uploadFile(identity, "bundle", bundle.path, "application/zip");
        }
        finally {
            removeTemporaryDirectory(bundle.directory);
        }
    }

    function runDocument2mdSerial(pdf) {
        const current = document2mdTail.then(() => runDocument2md(pdf));
        document2mdTail = current.catch(() => {});
        return current;
    }

    async function refreshMarkdown(literatureItem, pdf, existingMarkdown) {
        await runDocument2mdSerial(pdf);
        const markdown = await localMarkdown(literatureItem, pdf);
        if (!markdown) {
            throw new Error("document2md 未生成 Markdown");
        }
        if (existingMarkdown && existingMarkdown.id !== markdown.id) {
            await Zotero.Items.erase([existingMarkdown.id]);
        }
        return markdown;
    }

    const states = new Array(literature.length);
    let nextCheckIndex = 0;
    let checked = 0;
    let activeChecks = 0;

    async function runCheckWorker() {
        while (true) {
            const index = nextCheckIndex++;
            if (index >= literature.length) {
                return;
            }
            const literatureItem = literature[index];
            const title = titleOf(literatureItem);
            const entry = { item: literatureItem, title };
            activeChecks++;
            updateCheckProgress(batch, checked, literature.length, activeChecks);
            try {
                const identity = await attachmentIdentity(literatureItem);
                const key = citationKey(literatureItem) || literatureItem.key;
                let pdf = await localPdf(literatureItem);
                if (pdf && pdf.getField("title") !== "PDF") {
                    pdf.setField("title", "PDF");
                    await pdf.saveTx();
                }
                const markdown = await localMarkdown(literatureItem, pdf);
                let localPdfSha256 = "";
                if (pdf) {
                    const path = await pdf.getFilePathAsync();
                    if (path && await IOUtils.exists(path)) {
                        localPdfSha256 = sha256File(path);
                    }
                }
                states[index] = {
                    literatureItem,
                    title,
                    entry,
                    identity,
                    key,
                    pdf,
                    markdown,
                    localPdfSha256,
                    remote: await getRemoteState(identity, true),
                };
            }
            catch (error) {
                states[index] = { literatureItem, title, entry, error };
            }
            finally {
                activeChecks--;
                checked++;
                updateCheckProgress(batch, checked, literature.length, activeChecks);
            }
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(SYNC_CONCURRENCY, literature.length) },
            runCheckWorker
        )
    );

    if (IS_PUBLISHER) {
        processed = 0;
        for (const state of states) {
            try {
                if (state.error) {
                    throw state.error;
                }
                let { pdf, markdown } = state;
                if (!pdf || !state.localPdfSha256) {
                    throw new Error("教师发布要求本地存在 PDF");
                }
                const remoteHash = remotePdfSha256(state.remote);
                const pdfMatches = (
                    state.remote.pdf.status === "cached"
                    && remoteHash === state.localPdfSha256
                );
                const bundleCached = state.remote.bundle.status === "cached";

                if (!markdown || !await markdownMatchesPdf(markdown, pdf)) {
                    updateBatchProgress(
                        batch,
                        processed,
                        literature.length,
                        "处理中 · Markdown 转换"
                    );
                    markdown = await refreshMarkdown(state.literatureItem, pdf, markdown);
                }

                if (pdfMatches && bundleCached) {
                    addResult(false);
                }
                else {
                    await publishAttachments(state.identity, pdf, markdown, !pdfMatches);
                    addResult(true);
                }
            }
            catch (error) {
                addFailure(state.entry, error);
            }
            finally {
                finishItem();
            }
        }
    }
    else {
        processed = 0;
        let nextProcessIndex = 0;
        let activeSync = 0;

        async function processStudentState(state) {
            if (state.error) {
                throw state.error;
            }
            let {
                literatureItem,
                identity,
                key,
                pdf,
                markdown,
                localPdfSha256,
                remote,
            } = state;
            let changed = false;

            if (!pdf) {
                if (remote.pdf.status !== "cached" && !markdown && identity.searchable) {
                    remote = await getRemoteState(identity);
                }
                if (remote.pdf.status === "cached") {
                    pdf = await downloadPdf(literatureItem, key, remote.pdf.url);
                    localPdfSha256 = remotePdfSha256(remote);
                    changed = true;
                }
                else if (markdown) {
                    summary.mdOnly.push({
                        ...state.entry,
                        url: remote.pdf.status === "manual" ? remote.pdf.url : "",
                    });
                    return changed;
                }
                else if (remote.pdf.status === "manual" && remote.pdf.url) {
                    summary.manual.push({ ...state.entry, url: remote.pdf.url });
                    return changed;
                }
                else {
                    summary.notFound.push(state.entry);
                    return changed;
                }
            }
            else if (remote.pdf.status === "cached") {
                const remoteHash = remotePdfSha256(remote);
                if (!remoteHash || remoteHash !== localPdfSha256) {
                    pdf = await replacePdf(literatureItem, key, remote.pdf.url, pdf);
                    localPdfSha256 = remoteHash;
                    changed = true;
                    if (remote.bundle.status === "cached") {
                        markdown = await installBundle(literatureItem, identity, markdown);
                    }
                    else {
                        markdown = await refreshMarkdown(literatureItem, pdf, markdown);
                    }
                    return true;
                }
            }

            if (!markdown || !await markdownMatchesPdf(markdown, pdf)) {
                if (
                    remote.pdf.status === "cached"
                    && remote.bundle.status === "cached"
                    && remotePdfSha256(remote) === localPdfSha256
                ) {
                    markdown = await installBundle(literatureItem, identity, markdown);
                }
                else {
                    markdown = await refreshMarkdown(literatureItem, pdf, markdown);
                }
                changed = true;
            }
            return changed;
        }

        async function runStudentWorker() {
            while (true) {
                const index = nextProcessIndex++;
                if (index >= states.length) {
                    return;
                }
                const state = states[index];
                activeSync++;
                updateBatchProgress(
                    batch,
                    processed,
                    literature.length,
                    `并发同步更新 · ${activeSync} 项处理中`
                );
                try {
                    addResult(await processStudentState(state));
                }
                catch (error) {
                    addFailure(state.entry, error);
                }
                finally {
                    activeSync--;
                    finishItem();
                    updateBatchProgress(
                        batch,
                        processed,
                        literature.length,
                        `并发同步更新 · ${activeSync} 项处理中`
                    );
                }
            }
        }

        await Promise.all(
            Array.from(
                { length: Math.min(SYNC_CONCURRENCY, states.length) },
                runStudentWorker
            )
        );
    }
    await document2mdTail;

    showFinalSummary(batch, summary);
    activeBatch = null;
})().catch(error => {
    Zotero.logError(error);
    if (activeBatch) {
        activeBatch.progress.close();
    }
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline(`${IS_PUBLISHER ? "发布附件" : "同步附件"}失败`);
    const message = error && error.message ? error.message : String(error);
    progress.addDescription(escapeHtml(message).replace(/^附件服务\s+/i, ""));
    progress.show();
    activeBatch = null;
});
