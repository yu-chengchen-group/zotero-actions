// 菜单名称：转为MD
const API_URL = "https://api.chen-group.cn/v1/document2md";
const TEACHER_KEY = Services.env.get("CHEN_GROUP_API_KEY");
const MEMBER_KEY = Services.env.get("CHEN_GROUP_API_KEY_MEMBER");
const API_KEY = TEACHER_KEY || MEMBER_KEY;
const API_PROFILE = TEACHER_KEY ? "local" : "server";
const SERVER_POLL_INTERVAL_MS = 5000;

const STATUS_PROCESSING = "@md-处理中";
const STATUS_SUCCESS = "@md-已生成";
const STATUS_SKIPPED = "@md-跳过";
const STATUS_FAILED = "@md-失败";
const STATUS_REFERENCE_REVIEW = "@ref-待复核";
const MD_STATUSES = [STATUS_PROCESSING, STATUS_SUCCESS, STATUS_SKIPPED, STATUS_FAILED];
const FILE_ERROR_STATUSES = new Set([400, 413, 415, 422]);

const API_PROFILES = {
    server: {
        url: API_URL,
        authorization: `Bearer ${API_KEY}`,
        requiresKey: true,
    },
    local: {
        url: "http://127.0.0.1:18321/process",
        authorization: "",
        requiresKey: false,
    },
};

const ACTIVE_API = API_PROFILES[API_PROFILE];
const SOURCE_EXTENSIONS = new Set([
    ".pdf", ".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp",
    ".csv", ".docx", ".html", ".htm", ".pptx", ".xlsx",
]);
const IMAGE_EXTENSIONS = "bmp|jpeg|jpg|png|tif|tiff|webp";
const GENERATED_IMAGE_PATTERN = new RegExp(`_fig_\\d{3,}\\.(?:${IMAGE_EXTENSIONS})$`, "i");
const PROVENANCE_PATTERN = /^<!-- document2md-source-sha256: ([0-9a-f]{64}) -->$/;
const CLOUD_SOURCE_PREFIX = "@chen-source:";
const CLOUD_MD_PREFIX = "@chen-md:";


function getInvocationItems() {
    if (typeof items !== "undefined" && Array.isArray(items) && items.length) {
        return items;
    }
    if (typeof item !== "undefined" && item) {
        return [item];
    }
    return [];
}

function assertPersonalLibrary() {
    if (typeof collection !== "undefined" && collection) {
        if (collection.libraryID !== Zotero.Libraries.userLibraryID) {
            throw new Error("转为MD只允许在“我的文库”中执行");
        }
        return;
    }
    const selected = getInvocationItems();
    if (selected.some(value => value.libraryID !== Zotero.Libraries.userLibraryID)) {
        throw new Error("转为MD只允许在“我的文库”中执行");
    }
    if (!selected.length) {
        const pane = Zotero.getActiveZoteroPane();
        if (pane && pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
            throw new Error("转为MD只允许在“我的文库”中执行");
        }
    }
}


function leafName(path) {
    return path.split(/[\\/]/).pop();
}


function extensionOf(filename) {
    const index = filename.lastIndexOf(".");
    return index >= 0 ? filename.slice(index).toLowerCase() : "";
}


function attachmentName(attachment) {
    if (attachment.attachmentFilename) {
        return attachment.attachmentFilename;
    }

    try {
        const path = attachment.getFilePath();
        if (path) {
            return leafName(path);
        }
    }
    catch (error) {}

    return attachment.getField("title")
        || `attachment-${attachment.id}`;
}


function sourceEntry(attachment) {
    if (!attachment || attachment.deleted || !attachment.isAttachment()
        || attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL) {
        return null;
    }
    const name = attachmentName(attachment);
    const extension = extensionOf(name);
    if (!SOURCE_EXTENSIONS.has(extension) || GENERATED_IMAGE_PATTERN.test(name)) {
        return null;
    }

    let path = null;
    try {
        path = attachment.getFilePath();
    }
    catch (error) {}

    return {
        attachment,
        file: { name, path },
    };
}

function cloudID(attachment, prefix) {
    const tag = attachment.getTags().find(value =>
        value.tag.startsWith(prefix) && /^[A-Z0-9]{8}$/.test(value.tag.slice(prefix.length))
    );
    return tag ? tag.tag.slice(prefix.length) : "";
}

function markdownName(literature, source) {
    const name = source.file.name;
    const duplicates = getSourceAttachments(literature)
        .filter(value => value.file.name.toLowerCase() === name.toLowerCase());
    return `${name}${duplicates.length > 1
        ? `.${cloudID(source.attachment, CLOUD_SOURCE_PREFIX) || source.attachment.key}`
        : ""}.md`;
}

function hashFile(path) {
    const hash = Components.classes["@mozilla.org/security/hash;1"]
        .createInstance(Components.interfaces.nsICryptoHash);
    const stream = Components.classes["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Components.interfaces.nsIFileInputStream);
    const file = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);
    file.initWithPath(path);
    stream.init(file, 0x01, 0, 0);
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

async function markdownMatches(attachment, sourcePath, expectedHash) {
    if (!attachment || !attachment.isAttachment()
        || !isGeneratedMarkdownAttachment(attachment)) {
        return false;
    }
    const path = attachment.getFilePath();
    if (!path || !await IOUtils.exists(path) || !sourcePath
        || !await IOUtils.exists(sourcePath)) {
        return false;
    }
    const first = String(await Zotero.File.getContentsAsync(path, "utf-8"))
        .split(/\r?\n/, 1)[0];
    const match = first.match(PROVENANCE_PATTERN);
    return !!match && match[1] === expectedHash;
}


function getSourceAttachments(literature) {
    return literature.getAttachments()
        .map(id => Zotero.Items.get(id))
        .map(sourceEntry)
        .filter(Boolean)
        .sort((left, right) => left.file.name.localeCompare(
            right.file.name,
            undefined,
            { numeric: true, sensitivity: "base" }
        ));
}


function buildScopes(selectedItems) {
    const scopes = new Map();

    for (const value of selectedItems) {
        let literature;
        let selectedSource = null;

        if (value.isRegularItem()) {
            literature = value;
        }
        else if (value.isAttachment() && value.parentID) {
            literature = Zotero.Items.get(value.parentID);
            selectedSource = sourceEntry(value);
            if (!selectedSource) {
                continue;
            }
        }
        else {
            continue;
        }

        if (!literature || literature.deleted) {
            continue;
        }

        let scope = scopes.get(literature.id);
        if (!scope) {
            scope = {
                literature,
                allSources: false,
                selectedSources: new Map(),
            };
            scopes.set(literature.id, scope);
        }

        if (value.isRegularItem()) {
            scope.allSources = true;
            scope.selectedSources.clear();
        }
        else if (!scope.allSources) {
            scope.selectedSources.set(value.id, selectedSource);
        }
    }

    return [...scopes.values()].map(scope => ({
        literature: scope.literature,
        allSources: scope.allSources,
        sources: scope.allSources
            ? getSourceAttachments(scope.literature)
            : [...scope.selectedSources.values()].sort((left, right) =>
                left.file.name.localeCompare(
                    right.file.name,
                    undefined,
                    { numeric: true, sensitivity: "base" }
                )
            ),
    }));
}


async function setStatus(item, status) {
    for (const tag of MD_STATUSES) {
        item.removeTag(tag);
    }
    if (status) {
        item.addTag(status);
    }
    await item.saveTx();
}


async function allSourcesHaveMarkdown(literature) {
    const attachmentIndex = buildAttachmentIndex(literature);
    const sources = getSourceAttachments(literature);
    return (
        sources.length > 0
        && (await Promise.all(sources.map(async source => {
            const existing = attachmentIndex.get(markdownName(literature, source).toLowerCase()) || [];
            const { file } = source;
            return existing.length === 1 && file.path && await IOUtils.exists(file.path)
                && await markdownMatches(existing[0], file.path, hashFile(file.path));
        }))).every(Boolean)
    );
}


function buildAttachmentIndex(item) {
    const index = new Map();
    for (const attachmentID of item.getAttachments()) {
        const attachment = Zotero.Items.get(attachmentID);
        if (!attachment || !attachment.isAttachment()) {
            continue;
        }
        const name = attachmentName(attachment);
        if (!name) {
            continue;
        }
        const key = name.toLowerCase();
        const matches = index.get(key) || [];
        matches.push(attachment);
        index.set(key, matches);
    }
    return index;
}


function isGeneratedMarkdownAttachment(attachment) {
    return !!(
        attachment
        && attachment.isAttachment()
        && attachment.attachmentContentType === "text/markdown"
        && attachment.getField("title") === "Markdown"
        && extensionOf(attachmentName(attachment)) === ".md"
    );
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


async function writeMarkdownAttachment(item, attachmentIndex, filename, markdown) {
    const key = filename.toLowerCase();
    const existing = attachmentIndex.get(key) || [];
    if (existing.length > 1) {
        throw new Error(`输出附件重名：${filename}`);
    }
    if (existing.length && !isGeneratedMarkdownAttachment(existing[0])) {
        throw new Error(`拒绝覆盖非自动生成的 Markdown：${filename}`);
    }
    const directory = await Zotero.Attachments.createTemporaryStorageDirectory();
    const fileObject = Zotero.File.pathToFile(directory.path);
    fileObject.append(filename);
    let result;
    try {
        await Zotero.File.putContentsAsync(fileObject.path, markdown, "utf-8");
        result = await Zotero.Attachments.importFromFile({
            file: fileObject.path,
            parentItemID: item.id,
            title: "Markdown",
            contentType: "text/markdown",
        });
    }
    finally {
        removeTemporaryDirectory(directory);
    }

    if (Zotero.FullText) {
        await Zotero.FullText.queueItem(result);
    }
    return { result, previous: existing[0] || null };
}


async function downloadAsset(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        throw new Error("API 返回的图片资源不是 HTTP URL");
    }
    const headers = {};
    if (
        ACTIVE_API.authorization
        && url.startsWith(`${ACTIVE_API.url}/assets/`)
    ) {
        headers.Authorization = ACTIVE_API.authorization;
    }
    const response = await Zotero.HTTP.request("GET", url, {
        headers,
        responseType: "arraybuffer",
        successCodes: false,
        timeout: 0,
    });
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
    }
    return new Blob([response.response]);
}


function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}


function markError(error, kind, stage, fileName) {
    if (!error || typeof error !== "object") {
        error = new Error(String(error));
    }
    error.kind = error.kind || kind;
    error.stage = error.stage || stage;
    error.fileName = error.fileName || fileName;
    return error;
}


function logError(error) {
    const message = [
        "[document2md]",
        error.fileName || "未知文件",
        error.stage || "未知阶段",
        errorMessage(error),
    ].join(" | ");
    const logged = new Error(message);
    if (error.stack) {
        logged.stack = `${logged.stack}\nCaused by:\n${error.stack}`;
    }
    Zotero.logError(logged);
}


function responseDetail(response) {
    const value = response.response;
    if (typeof value === "string") {
        return value.slice(0, 500);
    }
    if (value && typeof value === "object") {
        const detail = value.detail || value.error || value.message || value.errorMsg;
        if (detail) {
            return String(detail).slice(0, 500);
        }
    }
    return "无响应正文";
}


async function convertFile(file, attachment) {
    let stage = "读取源文件";
    try {
        if (!file.path) {
            throw markError(
                new Error("本地文件不可用"),
                "local",
                stage,
                file.name
            );
        }

        let body = await IOUtils.read(file.path);
        const headers = {
            "Content-Type": attachment.attachmentContentType || "application/octet-stream",
            "X-Filename": encodeURIComponent(file.name),
        };
        if (ACTIVE_API.authorization) {
            headers.Authorization = ACTIVE_API.authorization;
        }

        stage = API_PROFILE === "server" ? "提交 document2md 任务" : "请求 document2md";
        let response;
        try {
            response = await Zotero.HTTP.request(
                API_PROFILE === "server" ? "POST" : "PUT",
                ACTIVE_API.url,
                {
                    body,
                    headers,
                    responseType: "json",
                    successCodes: false,
                    timeout: 0,
                }
            );
        }
        finally {
            body = null;
        }

        stage = "检查 HTTP 响应";
        if (response.status < 200 || response.status >= 300) {
            const error = new Error(
                `HTTP ${response.status}: ${responseDetail(response)}`
            );
            error.status = response.status;
            throw markError(
                error,
                FILE_ERROR_STATUSES.has(response.status) ? "file" : "service",
                stage,
                file.name
            );
        }

        let payload = response.response;
        if (API_PROFILE === "server") {
            stage = "检查任务提交响应";
            const jobID = payload && payload.job_id;
            if (typeof jobID !== "string" || !jobID) {
                throw new Error("API 未返回 job_id");
            }

            while (true) {
                await new Promise(resolve => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
                stage = "查询 document2md 任务";
                const pollResponse = await Zotero.HTTP.request(
                    "GET",
                    `${ACTIVE_API.url}?job_id=${encodeURIComponent(jobID)}`,
                    {
                        headers: { Authorization: ACTIVE_API.authorization },
                        responseType: "json",
                        successCodes: false,
                        timeout: 0,
                    }
                );
                if (pollResponse.status < 200 || pollResponse.status >= 300) {
                    const error = new Error(
                        `HTTP ${pollResponse.status}: ${responseDetail(pollResponse)}`
                    );
                    error.status = pollResponse.status;
                    throw markError(
                        error,
                        FILE_ERROR_STATUSES.has(pollResponse.status) ? "file" : "service",
                        stage,
                        file.name
                    );
                }

                const job = pollResponse.response;
                if (job && (job.status === "pending" || job.status === "running")) {
                    continue;
                }
                if (job && job.status === "failed") {
                    const status = Number(job.http_status) || 500;
                    const error = new Error(job.error || "document2md 转换失败");
                    error.status = status;
                    throw markError(
                        error,
                        FILE_ERROR_STATUSES.has(status) ? "file" : "service",
                        "document2md 后台转换",
                        file.name
                    );
                }
                if (!job || job.status !== "succeeded") {
                    throw new Error("API 返回未知任务状态");
                }
                payload = job.result;
                break;
            }
        }

        stage = "检查 JSON 响应";
        if (!Array.isArray(payload) || !payload[0]) {
            throw new Error("API 返回格式不是文档数组");
        }

        const document = payload[0];
        if (
            typeof document.page_content !== "string"
            || !document.page_content.trim()
        ) {
            throw new Error("API 未返回 Markdown 正文");
        }
        if (
            document.assets !== undefined
            && (
                !document.assets
                || typeof document.assets !== "object"
                || Array.isArray(document.assets)
            )
        ) {
            throw new Error("API assets 格式无效");
        }
        return document;
    }
    catch (error) {
        if (!error.kind) {
            const kind = stage === "读取源文件" ? "local" : "service";
            markError(error, kind, stage, file.name);
        }
        throw error;
    }
}


async function generatedSidecars(storageDirectory) {
    const names = new Set();
    for (const path of await IOUtils.getChildren(storageDirectory.path)) {
        const name = leafName(path);
        if (GENERATED_IMAGE_PATTERN.test(name)) {
            names.add(name.toLowerCase());
        }
    }
    return names;
}

async function cleanupGeneratedAssets(
    storageDirectory,
    oldSidecars,
    keepNames
) {
    const keep = new Set([...keepNames].map(name => name.toLowerCase()));

    for (const name of oldSidecars) {
        if (!keep.has(name)) {
            await IOUtils.remove(PathUtils.join(storageDirectory.path, name), {
                ignoreAbsent: true,
            });
        }
    }
}


async function writeConvertedDocument(item, source, document, expectedHash) {
    const assets = document.assets || {};
    const attachmentIndex = buildAttachmentIndex(item);
    const sourceName = source.file.name;
    const outputName = markdownName(item, source);
    let markdownAttachment;
    let previous;

    try {
        const imported = await writeMarkdownAttachment(
            item,
            attachmentIndex,
            outputName,
            `<!-- document2md-source-sha256: ${expectedHash} -->\n\n${document.page_content}`
        );
        markdownAttachment = imported.result;
        previous = imported.previous;
    }
    catch (error) {
        throw markError(error, "local", "写入 Markdown", sourceName);
    }

    try {
    const storageDirectory = Zotero.Attachments.getStorageDirectory(markdownAttachment);
    const oldSidecars = await generatedSidecars(storageDirectory);
    const keepNames = new Set();
    const filenames = Object.keys(assets);

    for (const filename of filenames) {
        if (filename !== leafName(filename)) {
            throw markError(
                new Error(`图片文件名无效：${filename}`),
                "service",
                `检查图片 ${filename}`,
                sourceName
            );
        }

        keepNames.add(filename);
        const path = PathUtils.join(storageDirectory.path, filename);
        let blob;
        try {
            blob = await downloadAsset(assets[filename]);
        }
        catch (error) {
            throw markError(
                error,
                "service",
                `下载图片 ${filename}`,
                sourceName
            );
        }
        try {
            await Zotero.File.putContentsAsync(path, blob);
        }
        catch (error) {
            throw markError(
                error,
                "local",
                `写入图片 ${filename}`,
                sourceName
            );
        }
    }

    try {
        await cleanupGeneratedAssets(
            storageDirectory,
            oldSidecars,
            keepNames
        );
    }
    catch (error) {
        throw markError(error, "local", "清理废弃图片", sourceName);
    }

    try {
        await Zotero.Sync.Storage.Local.updateSyncStates(
            [markdownAttachment],
            "to_upload"
        );
    }
    catch (error) {
        throw markError(error, "local", "标记附件同步", sourceName);
    }

    const relatedID = cloudID(source.attachment, CLOUD_SOURCE_PREFIX)
        || source.attachment.key;
    markdownAttachment.addTag(`${CLOUD_MD_PREFIX}${relatedID}`);
    await markdownAttachment.saveTx();
    if (previous && previous.id !== markdownAttachment.id) {
        await Zotero.Items.erase([previous.id]);
    }
    }
    catch (error) {
        if (markdownAttachment) {
            try {
                await Zotero.Items.erase([markdownAttachment.id]);
            }
            catch (cleanupError) {
                Zotero.logError(cleanupError);
            }
        }
        throw error;
    }
}


function duplicateSourceNames(sources) {
    const seen = new Set();
    const duplicates = new Set();
    for (const { file } of sources) {
        const name = file.name.toLowerCase();
        if (seen.has(name)) {
            duplicates.add(file.name);
        }
        seen.add(name);
    }
    return [...duplicates];
}


async function processScope(scope) {
    const { literature, allSources, sources } = scope;

    if (allSources && await allSourcesHaveMarkdown(literature)) {
        await setStatus(literature, STATUS_SUCCESS);
        return { status: "skipped" };
    }
    if (!sources.length) {
        await setStatus(literature, STATUS_SKIPPED);
        return {
            status: "skipped",
            details: ["没有可处理的文件附件"],
        };
    }

    await setStatus(literature, STATUS_PROCESSING);
    if (allSources) {
        literature.removeTag(STATUS_REFERENCE_REVIEW);
    }

    const failures = [];
    let referenceReview = false;

    for (const source of sources) {
        const { attachment, file } = source;
        try {
            if (!file.path || !await IOUtils.exists(file.path)) {
                throw markError(new Error("本地源文件不存在"), "file", "读取源文件", file.name);
            }
            const expected = hashFile(file.path);
            const name = markdownName(literature, source);
            const existing = buildAttachmentIndex(literature).get(name.toLowerCase()) || [];
            if (existing.length === 1 && await markdownMatches(existing[0], file.path, expected)) {
                continue;
            }
            const document = await convertFile(file, attachment);
            if (hashFile(file.path) !== expected) {
                throw markError(new Error("转换期间源文件发生变化"), "local", "校验源文件", file.name);
            }
            await writeConvertedDocument(literature, source, document, expected);
            referenceReview = referenceReview || document.reference_review === true;
        }
        catch (error) {
            logError(error);
            failures.push(
                `${file.name}｜${error.stage || "未知阶段"}｜${errorMessage(error)}`
            );

            if (error.kind !== "file") {
                await setStatus(literature, STATUS_FAILED);
                return {
                    status: "failed",
                    details: failures,
                    stopBatch: true,
                };
            }
        }
    }

    if (failures.length) {
        await setStatus(literature, STATUS_FAILED);
        return {
            status: "failed",
            details: failures,
        };
    }

    if (referenceReview) {
        literature.addTag(STATUS_REFERENCE_REVIEW);
    }

    await setStatus(
        literature,
        await allSourcesHaveMarkdown(literature) ? STATUS_SUCCESS : null
    );

    return { status: "success" };
}


await (async () => {
    assertPersonalLibrary();
    if (!ACTIVE_API) {
        throw new Error("无法确定 document2md 调用模式");
    }
    if (ACTIVE_API.requiresKey && !API_KEY) {
        throw new Error("缺少环境变量 CHEN_GROUP_API_KEY 或 CHEN_GROUP_API_KEY_MEMBER");
    }

    const scopes = buildScopes(getInvocationItems());
    if (!scopes.length) {
        throw new Error("请先选中文献或其可处理文件附件");
    }

    const summary = {
        total: scopes.length,
        success: 0,
        skipped: 0,
        failed: 0,
        stopped: false,
        details: [],
    };

    for (const scope of scopes) {
        if (summary.stopped) {
            break;
        }

        const result = await processScope(scope);
        summary[result.status]++;

        if (result.status === "failed") {
            const title = scope.literature.getField("title") || scope.literature.id;
            summary.details.push(`失败｜${title}｜${result.details.join("；")}`);
            if (result.stopBatch) {
                summary.stopped = true;
            }
        }
    }

    return [
        `文献 ${summary.total}｜成功 ${summary.success}｜跳过 ${summary.skipped}｜失败 ${summary.failed}`,
        ...summary.details,
    ].join("\n");
})().catch(error => {
    Zotero.logError(error);
    throw error;
});
