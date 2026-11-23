import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Modal, Space, Typography } from "antd";
import { FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetGroupSelect, useAssetGroups } from "@/components/assets/asset-group-select";
import { useAssetStore } from "@/stores/use-asset-store";

export type BatchAddItem = { id: string; title: string; coverUrl: string };

/** 批量加入「我的资产」前的确认：选目标分组（可当场新建），并勾掉不想加入的条目。 */
export function AssetBatchAddModal({ open, items, onCancel, onConfirm }: {
    open: boolean;
    items: BatchAddItem[];
    onCancel: () => void;
    onConfirm: (ids: string[], group: string) => Promise<void>;
}) {
    const { t } = useTranslation();
    const groups = useAssetGroups();
    const addGroup = useAssetStore((state) => state.addGroup);
    const [group, setGroup] = useState("");
    const [excluded, setExcluded] = useState<Set<string>>(new Set());
    const [newGroup, setNewGroup] = useState("");
    const [groupError, setGroupError] = useState("");
    const [saving, setSaving] = useState(false);
    // 目标分组在两次打开之间保留，期间被删除则回到未分组。
    const target = groups.includes(group) ? group : "";
    const selectedIds = items.filter((item) => !excluded.has(item.id)).map((item) => item.id);
    const allSelected = selectedIds.length === items.length;

    useEffect(() => {
        if (!open) return;
        setExcluded(new Set());
        setNewGroup("");
        setGroupError("");
    }, [open]);

    const createGroup = () => {
        const name = newGroup.trim();
        if (!name) return setGroupError(t("assets.group.nameRequired"));
        if (!addGroup(name)) return setGroupError(t("assets.group.nameExists"));
        setGroup(name);
        setNewGroup("");
        setGroupError("");
    };
    const toggle = (id: string) =>
        setExcluded((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    const confirm = async () => {
        setSaving(true);
        try {
            await onConfirm(selectedIds, target);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            title={t("assets.batchAdd.title")}
            open={open}
            width={760}
            onCancel={() => {
                if (!saving) onCancel();
            }}
            onOk={() => void confirm()}
            okText={t("assets.batchAdd.confirm", { count: selectedIds.length })}
            okButtonProps={{ disabled: !selectedIds.length }}
            cancelButtonProps={{ disabled: saving }}
            confirmLoading={saving}
            cancelText={t("common.cancel")}
        >
            <div className="space-y-4 pt-2">
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-stone-500 dark:text-stone-400">{t("assets.batchAdd.target")}</span>
                        <AssetGroupSelect className="w-48" value={target} onChange={(value) => setGroup(value || "")} />
                        <Space.Compact className="min-w-0 flex-1">
                            <Input
                                value={newGroup}
                                status={groupError ? "error" : undefined}
                                placeholder={t("assets.group.namePlaceholder")}
                                onChange={(event) => {
                                    setNewGroup(event.target.value);
                                    setGroupError("");
                                }}
                                onPressEnter={createGroup}
                            />
                            <Button icon={<FolderPlus className="size-4" />} onClick={createGroup}>
                                {t("assets.group.create")}
                            </Button>
                        </Space.Compact>
                    </div>
                    {groupError ? <Typography.Text type="danger" className="mt-1 block text-xs">{groupError}</Typography.Text> : null}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <Checkbox checked={allSelected} indeterminate={!allSelected && selectedIds.length > 0} onChange={() => setExcluded(allSelected ? new Set(items.map((item) => item.id)) : new Set())}>
                        {t("assets.batchAdd.selectAll")}
                    </Checkbox>
                    <Typography.Text type="secondary">{t("assets.batchAdd.hint", { count: selectedIds.length, total: items.length })}</Typography.Text>
                </div>
                <div className="thin-scrollbar grid max-h-[52vh] grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
                    {items.map((item) => {
                        const checked = !excluded.has(item.id);
                        return (
                            <div
                                key={item.id}
                                className={`relative cursor-pointer overflow-hidden rounded-lg border transition ${checked ? "border-stone-400 dark:border-stone-500" : "border-stone-200 opacity-45 dark:border-stone-800"}`}
                                onClick={() => toggle(item.id)}
                            >
                                <img src={item.coverUrl} alt={item.title} className="aspect-square w-full object-cover" />
                                <Checkbox className="absolute left-2 top-2" checked={checked} onClick={(event) => event.stopPropagation()} onChange={() => toggle(item.id)} />
                                <div className="truncate px-2 py-1.5 text-xs" title={item.title}>
                                    {item.title}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </Modal>
    );
}