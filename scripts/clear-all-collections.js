// 菜单名称：清空分类

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
            throw new Error("清空分类只允许在“我的文库”中执行");
        }
        return;
    }
    const selected = getInvocationItems();
    if (selected.some(value => value.libraryID !== Zotero.Libraries.userLibraryID)) {
        throw new Error("清空分类只允许在“我的文库”中执行");
    }
    if (!selected.length) {
        const pane = Zotero.getActiveZoteroPane();
        if (pane && pane.getSelectedLibraryID() !== Zotero.Libraries.userLibraryID) {
            throw new Error("清空分类只允许在“我的文库”中执行");
        }
    }
}

function showFailure(error) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("清空分类失败");
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

function confirmClearCollections(total, membershipCount) {
    return Services.prompt.confirm(
        Zotero.getMainWindow(),
        "清空分类",
        `清空 ${total} 文献的全部分类（${membershipCount}）？\n文献不会删除。`
    );
}

function createProgress(total) {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("清空分类");
    const statusLine = new progress.ItemProgress(null, "处理中");
    const detailLine = new progress.ItemProgress(null, "");
    statusLine.setProgress(0);
    progress.show();
    return { progress, statusLine, detailLine };
}

function updateProgress(batch, completed, total, removedMemberships) {
    const percent = total ? completed * 100 / total : 100;
    batch.statusLine.setProgress(percent);
    batch.statusLine.setText(`清空 ${completed}/${total}`);
    batch.detailLine.setText(`分类 ${removedMemberships}`);
}

function showSummary(batch, total, removedMemberships) {
    const progress = batch.progress;
    progress.changeHeadline("清空分类");
    batch.statusLine.setProgress(95);
    batch.statusLine.setText("完成");
    batch.detailLine.setProgress(100);
    batch.detailLine.setText(`总计 ${total}｜分类 ${removedMemberships}`);
    progress.startCloseTimer(5000);
    return `已清空 ${total} 文献的 ${removedMemberships} 分类归属`;
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

    const membershipCount = Array.from(literature.values())
        .reduce((sum, value) => sum + value.getCollections().length, 0);
    if (!confirmClearCollections(literature.size, membershipCount)) {
        return "已取消清空分类";
    }

    const batch = createProgress(literature.size);
    let removedMemberships = 0;
    let completed = 0;

    for (const parent of literature.values()) {
        const collectionIDs = parent.getCollections();
        if (collectionIDs.length) {
            parent.setCollections([]);
            await parent.saveTx();
            removedMemberships += collectionIDs.length;
        }
        completed++;
        updateProgress(
            batch,
            completed,
            literature.size,
            removedMemberships
        );
    }

    return showSummary(batch, literature.size, removedMemberships);
})().catch(error => {
    Zotero.logError(error);
    showFailure(error);
});
