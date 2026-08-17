"use client";

import * as React from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  UNITS_OF_MEASURE,
  getUnitsByCategory,
  type UnitCategory,
} from "@/lib/utils/units";
import { useT } from "@/lib/i18n/store";

interface UnitSelectProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /** Disable the control. */
  disabled?: boolean;
}

const CATEGORIES_KEYS: Array<{ value: UnitCategory; key: string }> = [
  { value: "weight", key: "misc-unit-weight" },
  { value: "volume", key: "misc-unit-volume" },
  { value: "length", key: "misc-unit-length" },
  { value: "area", key: "misc-unit-area" },
  { value: "count", key: "misc-unit-count" },
  { value: "other", key: "misc-unit-other" },
];

/**
 * Reusable grouped unit-of-measure dropdown.
 *
 * Lists every trade unit in 6 categories. If the current value isn't part of
 * the standard list (e.g. legacy data with "KG" instead of "kg"), it's shown
 * in a trailing "Custom" group so the user keeps their existing selection.
 */
export function UnitSelect({
  value,
  onChange,
  placeholder,
  className,
  disabled,
}: UnitSelectProps) {
  const t = useT();
  const effectivePlaceholder = placeholder || t("misc-select-unit");
  const isCustom =
    !!value && !UNITS_OF_MEASURE.some((u) => u.value === value);

  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder={effectivePlaceholder} />
      </SelectTrigger>
      <SelectContent>
        {CATEGORIES_KEYS.map((cat) => {
          const units = getUnitsByCategory(cat.value);
          if (units.length === 0) return null;
          return (
            <SelectGroup key={cat.value}>
              <SelectLabel>{t(cat.key)}</SelectLabel>
              {units.map((u) => (
                <SelectItem key={u.value} value={u.value}>
                  {u.label}
                </SelectItem>
              ))}
            </SelectGroup>
          );
        })}
        {isCustom && (
          <SelectGroup>
            <SelectLabel>{t("misc-unit-custom")}</SelectLabel>
            <SelectItem value={value}>{value}</SelectItem>
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}
