// 菜单名称：导出附件
const TARGET_DIR = String.raw`D:\zotero`;
const IMAGE_EXTENSIONS = "bmp|jpeg|jpg|png|tif|tiff|webp";
const GENERATED_FIG_PATTERN = new RegExp(
    `_fig_\\d{3,}\\.(?:${IMAGE_EXTENSIONS})$`,
    "i"
);

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
            throw new Error("导出附件只允许在“我的文库”中执行");
        }
        return;
    }
    const selected = getInvocationItems();
    if (selected.some(value => value.libraryID !== Zotero.Libraries.userLibraryID)) {
        throw new Error("导出附件只允许在“我的文库”中执行");
    }
    if (!selected.length) {
        const pane = Zotero.getActiveZoteroPane();
        if (!pane || pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
            throw new Error("导出附件只允许在“我的文库”中执行");
        }
    }
}

function addLiterature(result, value) {
    if (value && value.isRegularItem() && !value.deleted) {
        result.set(value.id, value);
        return;
    }
    if (value && value.isAttachment() && value.parentID) {
        const parent = Zotero.Items.get(value.parentID);
        if (parent && parent.isRegularItem() && !parent.deleted) {
            result.set(parent.id, parent);
        }
    }
}

function collectCollectionLiterature(sourceCollection, result) {
    for (const value of sourceCollection.getChildItems(false, false)) {
        addLiterature(result, value);
    }
    for (const child of Zotero.Collections.getByParent(sourceCollection.id, false)) {
        collectCollectionLiterature(child, result);
    }
}

async function resolveInvocationItems() {
    const literature = new Map();
    if (typeof collection !== "undefined" && collection) {
        collectCollectionLiterature(collection, literature);
        return [...literature.values()];
    }

    const selected = getInvocationItems();
    if (selected.length) {
        return selected;
    }

    const pane = Zotero.getActiveZoteroPane();
    if (!pane) {
        return [];
    }
    for (const value of await Zotero.Items.getAll(pane.getSelectedLibraryID(), false, false, false)) {
        addLiterature(literature, value);
    }
    return [...literature.values()];
}

function leafName(path) {
    return path.split(/[\\/]/).pop();
}

function fileExtension(filename) {
    const dotIndex = filename.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === filename.length - 1) {
        return "no-extension";
    }
    return filename.slice(dotIndex + 1).toLowerCase();
}

function pathToFile(path) {
    const file = Components.classes[
        "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile);
    file.initWithPath(path);
    return file;
}

function ensureDirectory(path) {
    const directory = pathToFile(path);
    if (!directory.exists()) {
        directory.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    }
    if (!directory.isDirectory()) {
        throw new Error(`目标路径不是文件夹：${path}`);
    }
    return directory;
}

function getExtensionDirectory(root, extension) {
    const directory = root.clone();
    directory.append(extension);
    if (!directory.exists()) {
        directory.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o755);
    }
    if (!directory.isDirectory()) {
        throw new Error(`附件分类路径不是文件夹：${directory.path}`);
    }
    return directory;
}

function getUniqueName(directory, filename) {
    let candidate = directory.clone();
    candidate.append(filename);
    if (!candidate.exists()) {
        return filename;
    }

    const dotIndex = filename.lastIndexOf(".");
    const hasExtension = dotIndex > 0 && dotIndex < filename.length - 1;
    const basename = hasExtension ? filename.slice(0, dotIndex) : filename;
    const extension = hasExtension ? filename.slice(dotIndex) : "";

    for (let index = 1; ; index++) {
        const uniqueName = `${basename} (${index})${extension}`;
        candidate = directory.clone();
        candidate.append(uniqueName);
        if (!candidate.exists()) {
            return uniqueName;
        }
    }
}

async function getLocalFile(attachment) {
    if (
        !attachment
        || !attachment.isAttachment()
        || attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL
    ) {
        return null;
    }

    const path = await attachment.getFilePathAsync();
    if (!path) {
        return null;
    }

    const source = pathToFile(path);
    if (!source.exists() || !source.isFile()) {
        return null;
    }

    const name = leafName(path);
    const extension = fileExtension(name);
    return { path, name, extension };
}

async function collectAttachments(selectedItems) {
    const attachmentMap = new Map();

    async function addAttachment(attachment) {
        if (!attachment) {
            return;
        }
        const file = await getLocalFile(attachment);
        if (file) {
            attachmentMap.set(file.path, file);
        }
        if (!file || !/\.md$/i.test(file.name)) {
            return;
        }
        const storage = Zotero.Attachments.getStorageDirectory(attachment);
        for (const path of await IOUtils.getChildren(storage.path)) {
            const name = leafName(path);
            if (!GENERATED_FIG_PATTERN.test(name)) {
                continue;
            }
            const source = pathToFile(path);
            if (!source.exists() || !source.isFile()) {
                continue;
            }
            attachmentMap.set(path, {
                path,
                name,
                extension: fileExtension(name),
            });
        }
    }

    for (const selected of selectedItems) {
        if (selected.isAttachment()) {
            await addAttachment(selected);
            continue;
        }
        if (!selected.isRegularItem()) {
            continue;
        }
        for (const attachmentID of selected.getAttachments()) {
            await addAttachment(await Zotero.Items.getAsync(attachmentID));
        }
    }
    return [...attachmentMap.values()];
}

function copyAttachment(file, root) {
    const source = pathToFile(file.path);
    const directory = getExtensionDirectory(root, file.extension);
    const destinationName = getUniqueName(directory, file.name);
    source.copyToFollowingLinks(directory, destinationName);
}

function errorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function showProgressWindow(headline, descriptions) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline(headline);
    for (const description of descriptions) {
        progress.addDescription(description);
    }
    progress.show();
}

function showSummary(batchProgress, summary) {
    const progress = batchProgress.progress;
    progress.changeHeadline("导出附件");
    batchProgress.statusLine.setProgress(95);
    batchProgress.statusLine.setText("完成");
    batchProgress.detailLine.setProgress(100);
    batchProgress.detailLine.setText(
        `总计 ${summary.total}｜成功 ${summary.copied}｜失败 ${summary.failed}`
    );
    progress.addDescription(`目标目录：${TARGET_DIR}`);
    for (const detail of summary.details) {
        progress.addDescription(detail);
    }
    progress.startCloseTimer(summary.failed ? 8000 : 3500);
    return [
        `总计 ${summary.total}｜成功 ${summary.copied}｜失败 ${summary.failed}`,
        `目标目录：${TARGET_DIR}`,
        ...summary.details,
    ].join("\n");
}

function createBatchProgress(total) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("导出附件");
    const statusLine = new progress.ItemProgress(null, "处理中");
    const detailLine = new progress.ItemProgress(null, "");
    statusLine.setProgress(0);
    progress.show();
    return { progress, statusLine, detailLine };
}

function updateBatchProgress(batchProgress, completed, total, text) {
    const percent = total ? completed * 100 / total : 100;
    batchProgress.statusLine.setProgress(percent);
    batchProgress.statusLine.setText(`导出 ${completed}/${total}`);
    batchProgress.detailLine.setText(text);
}

(async () => {
    // Actions & Tags 批处理时使用 items；逐条 item 调用直接跳过，避免重复处理。
    if (typeof item !== "undefined" && item) {
        return;
    }
    assertPersonalLibrary();

    const selectedItems = await resolveInvocationItems();
    if (!selectedItems.length) {
        throw new Error("请先选中文献或其文件附件");
    }

    const attachments = await collectAttachments(selectedItems);
    if (!attachments.length) {
        throw new Error("选中条目中没有找到可复制的本地附件");
    }

    const root = ensureDirectory(TARGET_DIR);
    const summary = {
        total: attachments.length,
        copied: 0,
        failed: 0,
        details: [],
    };
    const batchProgress = createBatchProgress(attachments.length);
    let completed = 0;

    for (const file of attachments) {
        try {
            copyAttachment(file, root);
            summary.copied++;
        }
        catch (error) {
            summary.failed++;
            summary.details.push(`失败｜${file.name}｜${errorMessage(error)}`);
        }
        completed++;
        updateBatchProgress(
            batchProgress,
            completed,
            attachments.length,
            file.name
        );
    }

    return showSummary(batchProgress, summary);
})().catch(error => {
    const message = errorMessage(error);
    showProgressWindow("导出附件失败", [message]);
    Zotero.logError(error);
});
