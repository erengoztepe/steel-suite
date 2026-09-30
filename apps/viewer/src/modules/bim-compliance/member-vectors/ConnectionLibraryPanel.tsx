"use client";

import { useMemo, useState } from "react";
import { Close, Trash, Edit } from "@/icons";
import { Button } from "@/components/button";
import type { SavedConnection } from "./connection-library-store";
import { LeftPanelShell } from "@/components/viewer-panels/LeftPanelShell";

interface ConnectionLibraryPanelProps {
  connections: SavedConnection[];
  /** Re-selects the connection's members and frames the camera — does NOT extract & isolate. */
  onSelect: (connection: SavedConnection) => void;
  onRemove: (connectionId: string) => void;
  onRename: (connectionId: string, currentName: string) => void;
  onOpenIdeaDesign?: (connection: SavedConnection) => void;
  onShowAll: () => void;
  onExportLibrary: (connectionIds: string[]) => void;
  onExportLibraryJson: (connectionIds: string[]) => void;
  onImportLibraryJson: (file: File) => void;
  width?: number;
  onWidthChange?: (width: number) => void;
}

export function ConnectionLibraryPanel({
  connections,
  onSelect,
  onRemove,
  onRename,
  onOpenIdeaDesign,
  onShowAll,
  onExportLibrary,
  onExportLibraryJson,
  onImportLibraryJson,
  width = 280,
  onWidthChange,
}: ConnectionLibraryPanelProps) {
  const [sortBy, setSortBy] = useState<"date_desc" | "date_asc" | "name_asc" | "name_desc">("date_desc");
  const [exportMode, setExportMode] = useState(false);
  const [selectedForExport, setSelectedForExport] = useState<Set<string>>(new Set());

  const sortedConnections = useMemo(() => {
    return [...connections].sort((a, b) => {
      if (sortBy.startsWith("date_")) {
        return sortBy === "date_desc" ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
      } else {
        const nameA = a.name.toLowerCase();
        const nameB = b.name.toLowerCase();
        if (nameA < nameB) return sortBy === "name_asc" ? -1 : 1;
        if (nameA > nameB) return sortBy === "name_asc" ? 1 : -1;
        return 0;
      }
    });
  }, [connections, sortBy]);

  return (
    <LeftPanelShell
      title="Connection Library"
      width={width}
      resizable={true}
      minWidth={240}
      maxWidth={600}
      defaultWidth={width}
      onWidthChange={onWidthChange}
    >
      {/* Controls */}
      <div className="flex flex-col gap-2 p-2 border-b border-border-primary">
            {!exportMode ? (
              <div className="flex flex-col gap-2">
                <Button
                  variant="primary"
                  className="w-full text-xs font-medium"
                  onClick={onShowAll}
                  disabled={connections.length === 0}
                >
                  Show All Connections
                </Button>
                <Button
                  variant="secondary"
                  className="w-full text-xs font-medium"
                  onClick={() => {
                    setSelectedForExport(new Set(connections.map((c) => c.id)));
                    setExportMode(true);
                  }}
                  disabled={connections.length === 0}
                >
                  Export Library
                </Button>
                <div className="relative w-full">
                  <input
                    type="file"
                    accept=".json"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onImportLibraryJson(file);
                      e.target.value = ''; // Reset
                    }}
                  />
                  <Button variant="secondary" className="w-full text-xs font-medium pointer-events-none">
                    Import JSON
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    className="flex-1 text-xs font-medium"
                    onClick={() => {
                      onExportLibrary(Array.from(selectedForExport));
                      setExportMode(false);
                    }}
                    disabled={selectedForExport.size === 0}
                  >
                    Excel
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1 text-xs font-medium"
                    onClick={() => {
                      onExportLibraryJson(Array.from(selectedForExport));
                      setExportMode(false);
                    }}
                    disabled={selectedForExport.size === 0}
                  >
                    JSON
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    className="flex-1 text-xs"
                    onClick={() => setSelectedForExport(new Set(connections.map((c) => c.id)))}
                  >
                    All
                  </Button>
                  <Button
                    variant="secondary"
                    className="flex-1 text-xs"
                    onClick={() => setSelectedForExport(new Set())}
                  >
                    None
                  </Button>
                  <Button
                    variant="secondary"
                    className="flex-1 text-xs"
                    onClick={() => setExportMode(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-text-secondary">Sort by:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="bg-bg-secondary text-text-primary border border-border-primary rounded px-2 py-1 text-sm outline-none"
              >
                <option value="date_desc">Newest First</option>
                <option value="date_asc">Oldest First</option>
                <option value="name_asc">Name (A-Z)</option>
                <option value="name_desc">Name (Z-A)</option>
              </select>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto px-2 pb-4">
            {sortedConnections.length === 0 ? (
              <p className="text-sm text-text-secondary text-center mt-4 italic">
                No connections saved for this file yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {sortedConnections.map((conn) => {
                  const isSelected = selectedForExport.has(conn.id);
                  return (
                    <div
                      key={conn.id}
                      className={`flex items-center justify-between p-2 rounded cursor-pointer border transition-all group ${
                        exportMode
                          ? isSelected
                            ? "bg-blue-50/50 border-blue-200"
                            : "bg-transparent border-transparent hover:border-border-primary hover:bg-bg-secondary"
                          : "bg-transparent border-transparent hover:border-border-primary hover:bg-bg-secondary"
                      }`}
                      onClick={() => {
                        if (exportMode) {
                          const newSet = new Set(selectedForExport);
                          if (isSelected) newSet.delete(conn.id);
                          else newSet.add(conn.id);
                          setSelectedForExport(newSet);
                        } else {
                          onSelect(conn);
                        }
                      }}
                    >
                      <div className="flex items-center min-w-0 flex-1">
                        {exportMode && (
                          <input
                            type="checkbox"
                            className="mr-3 cursor-pointer shrink-0"
                            checked={isSelected}
                            readOnly
                          />
                        )}
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium text-text-primary truncate">
                            {conn.name}
                          </span>
                          <span className="text-xs text-text-secondary truncate">
                            {new Date(conn.createdAt).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      
                      {!exportMode && (
                        <div className="flex shrink-0 ml-2 space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            className="p-1.5 h-auto text-gray-500 hover:text-brand-primary hover:bg-brand-primary/10 rounded transition-colors"
                            title="IDEA Design"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenIdeaDesign?.(conn);
                            }}
                          >
                            <span className="text-[10px] font-bold px-1">IDEA</span>
                          </button>
                          <button
                            className="p-1.5 h-auto text-gray-500 hover:text-blue-500 hover:bg-blue-100/50 rounded transition-colors"
                            title="Rename connection"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRename(conn.id, conn.name);
                            }}
                          >
                            <Edit height={16} width={16} />
                          </button>
                          <button
                            className="p-1.5 h-auto text-gray-500 hover:text-red-500 hover:bg-red-100/50 rounded transition-colors"
                            title="Remove connection"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm("Are you sure you want to delete this connection?")) {
                                onRemove(conn.id);
                              }
                            }}
                          >
                            <Trash height={16} width={16} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
    </LeftPanelShell>
  );
}
