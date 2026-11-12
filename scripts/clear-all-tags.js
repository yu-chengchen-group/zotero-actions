// 菜单名称：清空标签

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
            throw new Error("清空标签只允许在“我的文库”中执行");
        }
        return;
    }
    const selected = getInvocationItems();
    if (selected.some(value => value.libraryID !== Zotero.Libraries.userLibraryID)) {
        throw new Error("清空标签只允许在“我的文库”中执行");
    }
    if (!selected.length) {
        const pane = Zotero.getActiveZoteroPane();
        if (pane && pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
            throw new Error("清空标签只允许在“我的文库”中执行");
        }
    }
}

function showFailure(error) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("清空标签失败");
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

function collectLiterature(selected) {
    const literature = new Map();
    for (const value of selected) {
        const parent = parentLiterature(value);
        if (parent) {
            literature.set(parent.id, parent);
        }
    }
    return literature;
}

function confirmClearTags(total, tagCount) {
    return Services.prompt.confirm(
        Zotero.getMainWindow(),
        "清空标签",
        `清空 ${total} 文献的全部标签（${tagCount}）？`
    );
}

function createProgress(total) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("清空标签");
    const statusLine = new progress.ItemProgress(null, "处理中");
    const detailLine = new progress.ItemProgress(null, "");
    statusLine.setProgress(0);
    progress.show();
    return { progress, statusLine, detailLine };
}

function updateProgress(batch, completed, total, removedTags) {
    const percent = total ? completed * 100 / total : 100;
    batch.statusLine.setProgress(percent);
    batch.statusLine.setText(`清空 ${completed}/${total}`);
    batch.detailLine.setText(`标签 ${removedTags}`);
}

function showSummary(batch, total, removedTags) {
    const progress = batch.progress;
    progress.changeHeadline("清空标签");
    batch.statusLine.setProgress(95);
    batch.statusLine.setText("完成");
    batch.detailLine.setProgress(100);
    batch.detailLine.setText(`总计 ${total}｜标签 ${removedTags}`);
    progress.startCloseTimer(5000);
    return `已清空 ${total} 文献的 ${removedTags} 标签`;
}

(async () => {
    // Action Tags 菜单会先批量调用一次，再逐条调用；只处理批量调用，避免重复执行。
    if (typeof item !== "undefined" && item) {
        return;
    }
    assertPersonalLibrary();

    const literature = collectLiterature(getInvocationItems());
    if (!literature.size) {
        throw new Error("请先选中文献或其附件");
    }

    const tagCount = Array.from(literature.values())
        .reduce((sum, value) => sum + value.getTags().length, 0);
    if (!confirmClearTags(literature.size, tagCount)) {
        return "已取消清空标签";
    }

    const batch = createProgress(literature.size);
    let removedTags = 0;
    let completed = 0;

    for (const parent of literature.values()) {
        const tags = parent.getTags();
        for (const { tag } of tags) {
            parent.removeTag(tag);
        }
        if (tags.length) {
            await parent.saveTx();
            removedTags += tags.length;
        }
        completed++;
        updateProgress(
            batch,
            completed,
            literature.size,
            removedTags
        );
    }

    return showSummary(batch, literature.size, removedTags);
})().catch(error => {
    Zotero.logError(error);
    showFailure(error);
});
