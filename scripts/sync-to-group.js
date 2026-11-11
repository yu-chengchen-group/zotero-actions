// 菜单名称：同步到课题组
const TARGET_GROUP_ID = 6669851;


function getInvocationItems() {
    if (typeof items !== "undefined" && Array.isArray(items) && items.length) {
        return items;
    }
    if (typeof item !== "undefined" && item) {
        return [item];
    }
    return [];
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


function collectSelectedLiterature(values) {
    const result = new Map();
    for (const value of values) {
        const literature = parentLiterature(value);
        if (literature && !literature.deleted) {
            result.set(literature.id, literature);
        }
    }
    return [...result.values()];
}


async function resolveScope() {
    if (typeof collection !== "undefined" && collection) {
        if (collection.libraryID !== Zotero.Libraries.userLibraryID) {
            throw new Error("同步到课题组只允许在“我的文库”中执行");
        }
        return { kind: "collection", collection };
    }
    const selected = getInvocationItems();
    const pane = Zotero.getActiveZoteroPane();
    if (
        selected.length
        && pane
        && pane.getSelectedLibraryID() === Zotero.Libraries.userLibraryID
        && !(pane.getSelectedCollections()?.length)
    ) {
        const allItemIDs = await Zotero.Items.getAll(
            Zotero.Libraries.userLibraryID,
            false,
            false,
            true
        );
        const selectedIDs = new Set(selected.map(value => value.id));
        if (
            selectedIDs.size === allItemIDs.length
            && allItemIDs.every(id => selectedIDs.has(id))
        ) {
            return { kind: "library" };
        }
    }
    if (selected.length) {
        const literature = collectSelectedLiterature(selected);
        if (!literature.length) {
            throw new Error("当前选择中没有文献条目");
        }
        if (literature.some(value => value.libraryID !== Zotero.Libraries.userLibraryID)) {
            throw new Error("同步到课题组只允许在“我的文库”中执行");
        }
        return { kind: "items", literature };
    }
    if (pane && pane.getSelectedLibraryID() === Zotero.Libraries.userLibraryID) {
        return { kind: "library" };
    }
    throw new Error("同步到课题组只允许在“我的文库”中执行");
}


function citationKey(literature) {
    return String(literature.getField("citationKey") || "").trim();
}


function titleOf(literature) {
    return literature.getField("title") || citationKey(literature) || literature.key;
}


function targetGroup() {
    const group = Zotero.Groups.getAll().find(value => Number(value.groupID) === TARGET_GROUP_ID);
    if (!group) {
        throw new Error(`当前 Zotero 中没有 Group ${TARGET_GROUP_ID}`);
    }
    return group;
}


function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}


function sourceItemLink(item) {
    return `<a href="zotero://select/library/items/${item.key}">${escapeHtml(titleOf(item))}</a>`;
}


function createProgress() {
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("同步到课题组 0");
    const statusLine = new progress.ItemProgress(null, "处理中");
    const titleLine = new progress.ItemProgress(null, "");
    progress.show();
    return {
        progress,
        statusLine,
        titleLine,
        itemIDs: new Set(),
        collectionIDs: new Set(),
    };
}


function updateProgress(context, type, source, label) {
    const ids = type === "条目"
        ? context.batch.itemIDs
        : context.batch.collectionIDs;
    ids.add(source.id);
    const completed = context.batch.itemIDs.size + context.batch.collectionIDs.size;
    context.batch.progress.changeHeadline(`同步到课题组 ${completed}`);
    context.batch.statusLine.setText("处理中");
    context.batch.titleLine.setText(label);
}


async function buildTargetIndex(libraryID) {
    const index = new Map();
    const duplicates = new Set();
    const items = (await Zotero.Items.getAll(libraryID, false, false, false))
        .filter(item => item && item.isRegularItem() && !item.deleted);
    await Zotero.Items.loadDataTypes(items);
    for (const item of items) {
        const key = citationKey(item);
        if (!key) {
            continue;
        }
        if (index.has(key)) {
            duplicates.add(key);
        }
        else {
            index.set(key, item);
        }
    }
    for (const key of duplicates) {
        index.set(key, null);
    }
    return index;
}


function mirrorJson(source, targetLibraryID) {
    const clone = source.clone(targetLibraryID, {
        skipTags: true,
        includeCollections: false,
    });
    const json = clone.toJSON();
    for (const field of ["key", "version", "collections", "relations", "dateAdded", "dateModified"]) {
        delete json[field];
    }
    return json;
}


function managedNoteKind(noteHtml) {
    if (typeof noteHtml !== "string") {
        return null;
    }
    if (noteHtml.startsWith("<p><strong>Classification Record</strong></p><pre>")) {
        return "Classification Record";
    }
    const citations = /^<h1>(Citations\d*)<\/h1>\s*<p>Do not edit this note manually!<\/p>\s*<pre>/.exec(noteHtml);
    return citations ? citations[1] : null;
}


function latestNote(notes) {
    return notes.reduce((latest, note) => (
        !latest || note.version > latest.version
        || (note.version === latest.version && note.key > latest.key)
            ? note : latest
    ), null);
}


async function mirrorNotes(source, target, context) {
    const sourceByKind = new Map();
    for (const noteID of source.getNotes()) {
        const note = await Zotero.Items.getAsync(noteID);
        if (!note || note.deleted) {
            continue;
        }
        const kind = managedNoteKind(note.getNote());
        if (kind) {
            const selected = sourceByKind.get(kind);
            sourceByKind.set(kind, latestNote(selected ? [selected, note] : [note]));
        }
    }

    const targetNotes = [];
    for (const noteID of target.getNotes()) {
        const note = await Zotero.Items.getAsync(noteID);
        if (note && !note.deleted && managedNoteKind(note.getNote())) {
            targetNotes.push(note);
        }
    }
    const keep = new Set();
    for (const [kind, sourceNote] of sourceByKind) {
        let targetNote = await sourceNote.getLinkedItem(context.libraryID, true);
        if (targetNote && !targetNote.deleted && (
            targetNote.parentID !== target.id || managedNoteKind(targetNote.getNote()) !== kind
        )) {
            throw new Error(`受管理 Note 关联异常：${kind}`);
        }
        if (!targetNote || targetNote.deleted) {
            targetNote = latestNote(targetNotes.filter(note => managedNoteKind(note.getNote()) === kind));
        }
        if (!targetNote) {
            targetNote = sourceNote.clone(context.libraryID, {
                skipTags: true,
                includeCollections: false,
            });
        }
        targetNote.parentID = target.id;
        targetNote.setNote(sourceNote.getNote());
        targetNote.setTags(sourceNote.getTags());
        await Zotero.DB.executeTransaction(async () => {
            await targetNote.save();
            await sourceNote.addLinkedItem(targetNote);
        });
        keep.add(targetNote.id);
    }

    const stale = targetNotes.filter(note => !keep.has(note.id)).map(note => note.id);
    if (stale.length) {
        await Zotero.Items.erase(stale);
    }
}


async function mirrorItem(source, context) {
    updateProgress(context, "条目", source, titleOf(source));
    if (source.libraryID !== Zotero.Libraries.userLibraryID) {
        throw new Error("同步到课题组只允许在“我的文库”中执行");
    }
    await Zotero.Items.loadDataTypes([source]);
    const key = citationKey(source);
    if (!key) {
        throw new Error(`缺少 citationkey：${titleOf(source)}`);
    }
    if (context.targetIndex.has(key) && context.targetIndex.get(key) === null) {
        throw new Error(`群组中 citationkey 重复：${key}`);
    }

    let target = context.targetIndex.get(key);
    const created = !target;
    if (!target) {
        target = source.clone(context.libraryID, {
            skipTags: true,
            includeCollections: false,
        });
    }
    else {
        target.fromJSON(mirrorJson(source, context.libraryID), { strict: false });
    }
    target.setField("citationKey", key);
    target.setTags(source.getTags());
    await Zotero.DB.executeTransaction(async () => {
        await target.save();
        await source.addLinkedItem(target);
    });
    await mirrorNotes(source, target, context);
    context.targetIndex.set(key, target);
    if (created) {
        context.summary.created++;
    }
    return target;
}


function childCollections(parent, libraryID) {
    return parent
        ? Zotero.Collections.getByParent(parent.id, false)
        : Zotero.Collections.getByLibrary(libraryID, false);
}


async function ensureTargetCollection(source, targetParent, context) {
    updateProgress(context, "分类", source, source.name);
    let target = await source.getLinkedCollection(context.libraryID, true);
    if (target && target.deleted) {
        target = false;
    }
    if (!target) {
        const matches = childCollections(targetParent, context.libraryID)
            .filter(value => value.name === source.name);
        if (matches.length > 1) {
            throw new Error(`群组中同级分类重名：${source.name}`);
        }
        target = matches[0] || null;
    }

    const created = !target;
    let changed = false;
    if (!target) {
        target = source.clone(context.libraryID);
        target.parentID = targetParent ? targetParent.id : false;
        changed = true;
    }
    else {
        if (target.name !== source.name) {
            target.name = source.name;
            changed = true;
        }
        const expectedParent = targetParent ? targetParent.id : false;
        if (target.parentID !== expectedParent) {
            target.parentID = expectedParent;
            changed = true;
        }
    }
    await Zotero.DB.executeTransaction(async () => {
        if (changed) {
            await target.save();
        }
        await source.addLinkedCollection(target);
    });
    if (created) {
        context.summary.collectionsCreated++;
    }
    return target;
}


async function ensureTargetParentPath(source, context) {
    const ancestors = [];
    let parentID = source.parentID;
    while (parentID) {
        const parent = Zotero.Collections.get(parentID);
        if (!parent || parent.libraryID !== Zotero.Libraries.userLibraryID) {
            throw new Error(`无法解析父分类：${source.name}`);
        }
        ancestors.unshift(parent);
        parentID = parent.parentID;
    }

    let targetParent = null;
    for (const ancestor of ancestors) {
        targetParent = await ensureTargetCollection(ancestor, targetParent, context);
    }
    return targetParent;
}


async function syncCollection(source, targetParent, context, mirrorItems = true) {
    const target = await ensureTargetCollection(source, targetParent, context);
    const sourceItems = source.getChildItems(false, false)
        .filter(value => value && value.isRegularItem() && !value.deleted);
    const currentItemIDs = target.getChildItems(false, false)
        .filter(value => value && value.isRegularItem() && !value.deleted)
        .map(value => value.id);
    const targetItemIDs = new Set();
    let itemSyncFailed = false;

    for (const sourceItem of sourceItems) {
        try {
            if (mirrorItems) {
                const targetItem = await mirrorItem(sourceItem, context);
                targetItemIDs.add(targetItem.id);
            }
            else {
                await Zotero.Items.loadDataTypes([sourceItem]);
                const key = citationKey(sourceItem);
                const targetItem = key ? context.targetIndex.get(key) : null;
                if (targetItem) {
                    targetItemIDs.add(targetItem.id);
                }
            }
        }
        catch (error) {
            itemSyncFailed = true;
            context.summary.failed.push({ item: sourceItem, error: error.message || String(error) });
            Zotero.logError(error);
        }
    }

    const addIDs = [...targetItemIDs].filter(id => !currentItemIDs.includes(id));
    const removeIDs = itemSyncFailed
        ? []
        : currentItemIDs.filter(id => !targetItemIDs.has(id));
    if (addIDs.length || removeIDs.length) {
        await Zotero.DB.executeTransaction(async () => {
            if (addIDs.length) {
                await target.addItems(addIDs);
            }
            if (removeIDs.length) {
                await target.removeItems(removeIDs);
            }
        });
    }
    const sourceChildren = Zotero.Collections.getByParent(source.id, false);
    const keepTargetChildren = new Set();
    for (const sourceChild of sourceChildren) {
        const targetChild = await syncCollection(
            sourceChild,
            target,
            context,
            mirrorItems
        );
        keepTargetChildren.add(targetChild.id);
    }
    const staleChildren = Zotero.Collections.getByParent(target.id, false)
        .filter(value => !keepTargetChildren.has(value.id));
    if (staleChildren.length) {
        await Zotero.Collections.erase(staleChildren.map(value => value.id));
        context.summary.collectionsRemoved += staleChildren.length;
    }
    return target;
}


async function syncWholeLibrary(context) {
    const sourceItems = (await Zotero.Items.getAll(
        Zotero.Libraries.userLibraryID,
        false,
        false,
        false
    )).filter(value => value && value.isRegularItem() && !value.deleted);
    const sourceKeys = new Set();
    await Zotero.Items.loadDataTypes(sourceItems);
    for (const sourceItem of sourceItems) {
        try {
            const key = citationKey(sourceItem);
            if (!key) {
                throw new Error(`缺少 citationkey：${titleOf(sourceItem)}`);
            }
            sourceKeys.add(key);
            await mirrorItem(sourceItem, context);
        }
        catch (error) {
            context.summary.failed.push({ item: sourceItem, error: error.message || String(error) });
            Zotero.logError(error);
        }
    }

    const staleItems = [];
    for (const [key, target] of context.targetIndex) {
        if (target && !sourceKeys.has(key)) {
            staleItems.push(target.id);
        }
    }
    if (staleItems.length) {
        await Zotero.Items.erase(staleItems);
        context.summary.itemsRemoved += staleItems.length;
    }

    const sourceRoots = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, false);
    const keepRoots = new Set();
    for (const sourceRoot of sourceRoots) {
        const targetRoot = await syncCollection(sourceRoot, null, context, false);
        keepRoots.add(targetRoot.id);
    }
    const staleRoots = Zotero.Collections.getByLibrary(context.libraryID, false)
        .filter(value => !keepRoots.has(value.id));
    if (staleRoots.length) {
        await Zotero.Collections.erase(staleRoots.map(value => value.id));
        context.summary.collectionsRemoved += staleRoots.length;
    }
}


function showSummary(batch, summary) {
    const progress = batch.progress;
    progress.changeHeadline("同步到课题组");
    batch.statusLine.setProgress(95);
    batch.statusLine.setText("完成");
    batch.titleLine.setProgress(100);
    batch.titleLine.setText(
        `文献 ${batch.itemIDs.size}｜新增 ${summary.created}｜删除 ${summary.itemsRemoved}｜失败 ${summary.failed.length}`
    );
    const collectionLine = new progress.ItemProgress(
        null,
        `分类 ${batch.collectionIDs.size}｜新增 ${summary.collectionsCreated}｜删除 ${summary.collectionsRemoved}`
    );
    collectionLine.setProgress(100);
    for (const entry of summary.failed) {
        const title = titleOf(entry.item);
        const error = String(entry.error) === `缺少 citationkey：${title}`
            ? "缺少 citationkey"
            : String(entry.error);
        progress.addDescription("失败");
        progress.addDescription(sourceItemLink(entry.item));
        progress.addDescription(escapeHtml(error));
    }
    if (!summary.failed.length) {
        progress.startCloseTimer(5000);
    }
}


let activeBatch = null;


(async () => {
    if (typeof item !== "undefined" && item) {
        return;
    }
    const keyScope = Zotero.Prefs.get("translators.better-bibtex.keyScope") || "library";
    if (keyScope === "global") {
        throw new Error("Better BibTeX citationkey 唯一范围必须为 Library，才能在个人库和群组库保持相同 citationkey");
    }

    const scope = await resolveScope();
    const group = targetGroup();
    const batch = createProgress();
    activeBatch = batch;
    const summary = {
        created: 0,
        itemsRemoved: 0,
        collectionsCreated: 0,
        collectionsRemoved: 0,
        failed: [],
    };
    const context = {
        libraryID: group.libraryID,
        targetIndex: await buildTargetIndex(group.libraryID),
        summary,
        batch,
    };

    if (scope.kind === "items") {
        for (const sourceItem of scope.literature) {
            try {
                await mirrorItem(sourceItem, context);
            }
            catch (error) {
                summary.failed.push({ item: sourceItem, error: error.message || String(error) });
                Zotero.logError(error);
            }
        }
    }
    else if (scope.kind === "collection") {
        const targetParent = await ensureTargetParentPath(scope.collection, context);
        await syncCollection(scope.collection, targetParent, context);
    }
    else {
        await syncWholeLibrary(context);
    }

    showSummary(batch, summary);
    activeBatch = null;
})().catch(error => {
    Zotero.logError(error);
    if (activeBatch) {
        activeBatch.progress.close();
    }
    const progress = new Zotero.ProgressWindow();
    progress.changeHeadline("同步到课题组失败");
    progress.addDescription(escapeHtml(error && error.message ? error.message : String(error)));
    progress.show();
    activeBatch = null;
});
