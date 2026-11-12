// 菜单名称：清空产物
const STATUS_TAGS = [
    "@md-处理中",
    "@md-已生成",
    "@md-跳过",
    "@md-失败",
    "@ref-待复核",
];

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
            throw new Error("清空产物只允许在“我的文库”中执行");
        }
        return;
    }
    const selected = getInvocationItems();
    if (selected.some(value => value.libraryID !== Zotero.Libraries.userLibraryID)) {
        throw new Error("清空产物只允许在“我的文库”中执行");
    }
    if (!selected.length) {
        const pane = Zotero.getActiveZoteroPane();
        if (pane && pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
            throw new Error("清空产物只允许在“我的文库”中执行");
        }
    }
}

function showFailure(error) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("清空产物失败");
    progress.addDescription(error && error.message ? error.message : String(error));
    progress.show();
}

function parentLiterature(value) {
    if (value.isRegularItem()) {
        return value;
    }
    if (value.isAttachment() && value.parentID) {
        const parent = Zotero.Items.get(value.parentID);
        return parent && parent.isRegularItem() ? parent : null;
    }
    return null;
}

function attachmentName(attachment) {
    try {
        const path = attachment.getFilePath();
        if (path) {
            return path.split(/[\\/]/).pop();
        }
    }
    catch (error) {}
    return attachment.attachmentFilename || attachment.getField("title") || "";
}

function isGeneratedMarkdown(attachment, name) {
    return !!(
        attachment.attachmentContentType === "text/markdown"
        && attachment.getField("title") === "Markdown"
        && name.toLowerCase().endsWith(".md")
    );
}

function hasTag(item, tag) {
    return item.getTags().some(value => value.tag === tag);
}

async function cleanLiterature(literature) {
    const attachments = literature.getAttachments()
        .map(id => Zotero.Items.get(id))
        .filter(attachment => attachment && attachment.isAttachment());

    const generatedIDs = [];
    for (const attachment of attachments) {
        const name = attachmentName(attachment);
        if (!name || !isGeneratedMarkdown(attachment, name)) {
            continue;
        }
        generatedIDs.push(attachment.id);
    }
    if (generatedIDs.length) {
        await Zotero.Items.erase(generatedIDs);
    }

    let removedTags = 0;
    for (const tag of STATUS_TAGS) {
        if (hasTag(literature, tag)) {
            literature.removeTag(tag);
            removedTags++;
        }
    }
    if (removedTags) {
        await literature.saveTx();
    }

    return { removedAttachments: generatedIDs.length, removedTags };
}

function confirmCleanup(total) {
    return Services.prompt.confirm(
        Zotero.getMainWindow(),
        "清空产物",
        `清空 ${total} 文献的产物和状态标签？`
    );
}

function createBatchProgress(total) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("清空产物");
    const statusLine = new progress.ItemProgress(null, "处理中");
    const detailLine = new progress.ItemProgress(null, "");
    statusLine.setProgress(0);
    progress.show();
    return { progress, statusLine, detailLine };
}

function updateBatchProgress(batchProgress, completed, total, text) {
    const percent = total ? completed * 100 / total : 100;
    batchProgress.statusLine.setProgress(percent);
    batchProgress.statusLine.setText(`清空 ${completed}/${total}`);
    batchProgress.detailLine.setText(text);
}

function showSummary(batchProgress, summary) {
    const message = `总计 ${summary.total}｜产物 ${summary.removedAttachments}｜标签 ${summary.removedTags}`;
    const progress = batchProgress.progress;
    progress.changeHeadline("清空产物");
    batchProgress.statusLine.setProgress(95);
    batchProgress.statusLine.setText("完成");
    batchProgress.detailLine.setProgress(100);
    batchProgress.detailLine.setText(message);
    progress.startCloseTimer(5000);
    return message;
}

(async () => {
    if (typeof item !== "undefined" && item) {
        return;
    }
    assertPersonalLibrary();

    const selected = getInvocationItems();
    const literature = new Map();

    for (const value of selected) {
        const parent = parentLiterature(value);
        if (parent) {
            literature.set(parent.id, parent);
        }
    }

    if (!literature.size) {
        throw new Error("请先选中文献或其附件");
    }

    if (!confirmCleanup(literature.size)) {
        return "已取消清空产物";
    }

    let removedAttachments = 0;
    let removedTags = 0;
    let completed = 0;
    const batchProgress = createBatchProgress(literature.size);
    for (const parent of literature.values()) {
        const result = await cleanLiterature(parent);
        removedAttachments += result.removedAttachments;
        removedTags += result.removedTags;
        completed++;
        updateBatchProgress(
            batchProgress,
            completed,
            literature.size,
            `产物 ${removedAttachments}｜标签 ${removedTags}`
        );
    }

    return showSummary(batchProgress, {
        total: literature.size,
        removedAttachments,
        removedTags,
    });
})().catch(error => {
    Zotero.logError(error);
    showFailure(error);
});
