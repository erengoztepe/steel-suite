/**
 * LoadInputForm — compact form for entering design loads (N, V, M).
 *
 * Pre-filled with smart defaults computed from member capacity. Shows
 * capacity utilization percentage next to each field.
 */

import { useState } from 'react';
import type { DesignLoads, MemberCapacity } from './types';

interface LoadInputFormProps {
  defaultLoads: DesignLoads;
  memberCapacity: MemberCapacity | null;
  onSubmit: (loads: DesignLoads) => void;
  onBack: () => void;
}

export function LoadInputForm({
  defaultLoads,
  memberCapacity,
  onSubmit,
  onBack,
}: LoadInputFormProps) {
  const [loads, setLoads] = useState<DesignLoads>(defaultLoads);

  const handleChange = (field: keyof DesignLoads, value: string) => {
    setLoads(prev => ({ ...prev, [field]: parseFloat(value) || 0 }));
  };

  const pct = (value: number, capacity: number | undefined): string | null => {
    if (!capacity || capacity === 0) return null;
    return `${Math.round(Math.abs(value / capacity) * 100)}%`;
  };

  const fields: Array<{
    key: keyof DesignLoads;
    label: string;
    unit: string;
    capacityKey: keyof MemberCapacity | null;
    capacityLabel: string;
    min?: number;
  }> = [
    { key: 'N', label: 'Eksenel Kuvvet', unit: 'kN', capacityKey: 'Npl', capacityLabel: 'Npl' },
    { key: 'V', label: 'Kesme Kuvveti', unit: 'kN', capacityKey: 'Vpl', capacityLabel: 'Vpl', min: 0 },
    { key: 'M', label: 'Eğilme Momenti', unit: 'kNm', capacityKey: 'Mpl', capacityLabel: 'Mpl' },
  ];

  return (
    <div className="flex flex-col gap-4 p-4 animate-[ve-fade-in_0.3s_ease-out]">
      {/* Smart defaults explanation */}
      <div className="text-xs text-text-secondary bg-bg-secondary p-3 rounded-lg border border-border-primary/50">
        ℹ️ Varsayılan değerler profil kapasitesine göre hesaplanmıştır.
        {memberCapacity && (
          <span className="block mt-1 text-text-primary font-mono text-[10px]">
            {memberCapacity.profile} / {memberCapacity.steelGrade}
          </span>
        )}
      </div>

      {/* Load input fields */}
      <div className="flex flex-col gap-4">
        {fields.map(({ key, label, unit, capacityKey, capacityLabel, min }) => {
          const capValue = memberCapacity && capacityKey
            ? (memberCapacity[capacityKey] as number)
            : undefined;
          const utilization = pct(loads[key], capValue);

          return (
            <div key={key} className="flex flex-col gap-1">
              <label className="text-sm font-medium text-text-primary flex justify-between">
                <span>{label}, {key} ({unit})</span>
                {capValue != null && (
                  <span className="text-text-secondary text-[10px] font-normal">
                    {capacityLabel} = {capValue} {unit}
                  </span>
                )}
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={loads[key]}
                  min={min}
                  onChange={e => handleChange(key, e.target.value)}
                  className="w-full bg-bg-secondary border border-border-input text-text-primary rounded-lg px-3 py-2 text-sm outline-none focus:border-brand-primary transition-colors"
                />
                {utilization && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-text-secondary font-medium">
                    ({utilization})
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex gap-3 mt-2">
        <button
          type="button"
          onClick={onBack}
          className="flex-1 px-4 py-2 rounded-xl text-sm font-medium text-text-primary bg-transparent border border-border-primary hover:bg-bg-secondary transition-colors"
        >
          Geri
        </button>
        <button
          type="button"
          onClick={() => onSubmit(loads)}
          className="flex-1 px-4 py-2 rounded-xl text-sm font-medium bg-brand-primary text-text-accent hover:bg-brand-primary-hover transition-colors"
        >
          Analiz Et
        </button>
      </div>
    </div>
  );
}
