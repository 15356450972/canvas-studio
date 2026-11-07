import { useMemo } from "react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";

import { getAssetGroups, useAssetStore } from "@/stores/use-asset-store";

export function useAssetGroups() {
    const groups = useAssetStore((state) => state.groups);
    const assets = useAssetStore((state) => state.assets);
    return useMemo(() => getAssetGroups(groups, assets), [groups, assets]);
}

export function AssetGroupSelect({ value, onChange, allowAll = false, size, className, disabled }: {
    value?: string;
    onChange?: (value: string | undefined) => void;
    allowAll?: boolean;
    size?: "small" | "middle" | "large";
    className?: string;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    const groups = useAssetGroups();
    return (
        <Select
            aria-label={t("assets.group.label")}
            className={className}
            size={size}
            disabled={disabled}
            showSearch
            optionFilterProp="label"
            value={value === undefined && allowAll ? "all" : value ? `group:${value}` : "ungrouped"}
            onChange={(next: string) => onChange?.(next === "all" ? undefined : next === "ungrouped" ? "" : next.slice(6))}
            options={[
                ...(allowAll ? [{ value: "all", label: t("assets.group.all") }] : []),
                { value: "ungrouped", label: t("assets.group.ungrouped") },
                ...groups.map((group) => ({ value: `group:${group}`, label: group })),
            ]}
        />
    );
}
