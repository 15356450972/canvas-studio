import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Checkbox, Empty, Input, Modal, Pagination, Tag, theme } from "antd";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetGroupSelect } from "@/components/assets/asset-group-select";
import { cn } from "@/lib/utils";
import { matchesAssetGroup, useAssetStore, type Asset } from "@/stores/use-asset-store";

export type InsertAssetPayload = { kind: "text"; content: string; title: string } | { kind: "image"; dataUrl: string; title: string; storageKey?: string } | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number };

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void;
    onInsertMany?: (payloads: InsertAssetPayload[]) => Promise<void> | void;
    onClose: () => void;
};

export function AssetPickerModal({ open, onInsert, onInsertMany, onClose }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [importing, setImporting] = useState(false);
    const importingRef = useRef(false);
    const insertMany = async (payloads: InsertAssetPayload[]) => {
        if (!onInsertMany || importingRef.current || !payloads.length) return;
        importingRef.current = true;
        setImporting(true);
        try {
            await onInsertMany(payloads);
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "资产导入失败，请重试");
        } finally {
            importingRef.current = false;
            setImporting(false);
        }
    };
    return (
        <Modal title={t("canvas.assetPicker.title")} open={open} onCancel={() => { if (!importingRef.current) onClose(); }} closable={!importing} keyboard={!importing} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <MyAssetsTab onInsert={onInsert} onInsertMany={onInsertMany ? insertMany : undefined} importing={importing} />
        </Modal>
    );
}

const PAGE_SIZE = 8;
const kindOptions = ["all", "text", "image", "video"];

function PickerCard({ title, kind, cover, selected, multiple, disabled, onClick }: { title: string; kind: string; cover: string; selected: boolean; multiple: boolean; disabled: boolean; onClick: () => void }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    return (
        <button
            type="button"
            className="group relative cursor-pointer overflow-hidden rounded-lg border text-left transition disabled:cursor-wait"
            style={{ borderColor: selected ? token.colorPrimary : token.colorBorder, background: selected ? token.controlItemBgActive : token.colorBgContainer, color: token.colorText }}
            aria-pressed={multiple ? selected : undefined}
            disabled={disabled}
            onClick={onClick}
        >
            {cover ? (
                <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center p-3 text-center text-xs leading-5" style={{ color: token.colorTextSecondary }}>{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{t(`assets.kinds.${kind}`)}</Tag>
                </div>
            </div>
            {multiple ? (
                <span className="pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs" style={{ background: token.colorBgContainer, color: selected ? token.colorPrimary : token.colorTextSecondary }}>{selected ? "已选择" : "未选择"}</span>
            ) : (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-medium opacity-0 transition group-hover:opacity-100" style={{ background: token.colorBgMask, color: token.colorWhite }}>{t("canvas.assetPicker.insert")}</div>
            )}
        </button>
    );
}

function buildPayload(asset: Asset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title };
    return asset.kind === "video" ? { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height } : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title };
}

function MyAssetsTab({ onInsert, onInsertMany, importing }: Pick<Props, "onInsert" | "onInsertMany"> & { importing: boolean }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [groupFilter, setGroupFilter] = useState<string>();
    const [page, setPage] = useState(1);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video")
            .filter((a) => matchesAssetGroup(a, groupFilter) && (kindFilter === "all" || a.kind === kindFilter))
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter, groupFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);
    const selected = useMemo(() => filtered.filter((asset) => selectedIds.has(asset.id)), [filtered, selectedIds]);
    const allSelected = filtered.length > 0 && selected.length === filtered.length;

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const handleInsert = (asset: Asset) => {
        if (!onInsertMany) return onInsert(buildPayload(asset));
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(asset.id)) next.delete(asset.id);
            else next.add(asset.id);
            return next;
        });
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    disabled={importing}
                    prefix={<Search className="size-3.5" style={{ color: token.colorTextPlaceholder }} />}
                    placeholder={t("canvas.assetPicker.search")}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setSelectedIds(new Set());
                        setKeyword(e.target.value);
                    }}
                />
                <AssetGroupSelect className="w-40" size="small" disabled={importing} allowAll value={groupFilter} onChange={(value) => { setGroupFilter(value); setPage(1); setSelectedIds(new Set()); }} />
                <div className="flex gap-1.5">
                    {kindOptions.map((option) => (
                        <Tag.CheckableTag
                            key={option}
                            checked={kindFilter === option}
                            className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                            onChange={() => {
                                if (importing) return;
                                setPage(1);
                                setSelectedIds(new Set());
                                setKindFilter(option);
                            }}
                        >
                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            {onInsertMany && (
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                    <Checkbox checked={allSelected} indeterminate={selected.length > 0 && !allSelected} disabled={importing || !filtered.length} onChange={(e) => setSelectedIds(new Set(e.target.checked ? filtered.map((asset) => asset.id) : []))}>
                        {allSelected ? "取消全选" : "全选"}（筛选结果全部 {filtered.length} 项，含所有页）
                    </Checkbox>
                    <span style={{ color: token.colorTextSecondary }}>已选择 {selected.length} / {filtered.length} 项</span>
                </div>
            )}

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.kind} cover={asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "")} selected={selectedIds.has(asset.id)} multiple={!!onInsertMany} disabled={importing} onClick={() => handleInsert(asset)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.empty")} className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination disabled={importing} size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
            {onInsertMany && (
                <div className="flex justify-end">
                    <Button type="text" loading={importing} disabled={!selected.length} onClick={() => void onInsertMany(selected.map(buildPayload))}>{importing ? "正在导入" : `导入所选（${selected.length}）`}</Button>
                </div>
            )}
        </div>
    );
}
