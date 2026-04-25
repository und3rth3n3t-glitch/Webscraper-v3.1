import { useState } from 'react';
import { GripVertical } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { useRunStore } from '../stores/runStore';
import BackButton from './BackButton';
import type { MappingColumn, DataMapping } from '../../types/config';

export default function DataMappingView() {
  const { setDataMapping, saveCurrentConfig } = useConfigStore();
  const { showToast } = useUiStore();
  const results = useRunStore(s => s.results);

  const initialColumns: MappingColumn[] = (() => {
    const iterations = results?.iterations || [];
    const allData = iterations.flatMap(i => i.data || []);
    const nameCounts = new Map<string, number>();
    for (const row of allData) {
      for (const key of Object.keys(row)) {
        nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
      }
    }
    const names = [...nameCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
    const seen = new Map<string, number>();
    return names.map((name, i) => {
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      return {
        id: crypto.randomUUID(),
        originalName: name,
        displayName: count > 1 ? `${name}_${count}` : name,
        enabled: true,
        position: i,
        sourceType: 'scrapeElement' as const,
      };
    });
  })();

  const [columns, setColumns] = useState<MappingColumn[]>(initialColumns);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setColumns(prev => {
      const oldIndex = prev.findIndex(c => c.id === active.id);
      const newIndex = prev.findIndex(c => c.id === over.id);
      return arrayMove(prev, oldIndex, newIndex).map((c, i) => ({ ...c, position: i }));
    });
  };

  const updateColumn = (id: string, changes: Partial<MappingColumn>) => {
    setColumns(prev => prev.map(c => c.id === id ? { ...c, ...changes } : c));
  };

  const handleSave = async () => {
    const mapping: DataMapping = { version: 1, columns };
    setDataMapping(mapping);
    try {
      await saveCurrentConfig();
      showToast('Mapping saved.', 'success');
    } catch {
      showToast('Mapping set but config save failed.', 'error');
    }
  };

  const activeColumns = columns.filter(c => c.enabled);
  const previewData = (results?.iterations || [])
    .flatMap(i => i.data || [])
    .slice(0, 3)
    .map(row => {
      const out: Record<string, unknown> = {};
      for (const col of activeColumns) {
        if (col.originalName in row) {
          out[col.displayName] = row[col.originalName];
        }
      }
      return out;
    });

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Map Output</h2>
      </div>

      <p className="view-subtitle">Rename, reorder, or hide columns before saving.</p>

      <div className="data-mapping-layout">
        <div className="data-mapping-columns">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={columns.map(c => c.id)} strategy={verticalListSortingStrategy}>
              {columns.map(col => (
                <MappingRow key={col.id} column={col} onChange={changes => updateColumn(col.id, changes)} />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        <div className="data-mapping-preview">
          <p className="form-label">Preview (first 3 rows)</p>
          <pre className="json-preview">
            {JSON.stringify(previewData, null, 2)}
          </pre>
        </div>
      </div>

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={handleSave}>
          Save Mapping
        </button>
      </div>
    </div>
  );
}

interface MappingRowProps {
  column: MappingColumn;
  onChange: (changes: Partial<MappingColumn>) => void;
}

function MappingRow({ column, onChange }: MappingRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: column.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="mapping-row">
      <span className="mapping-drag-handle" {...attributes} {...listeners}>
        <GripVertical size={14} />
      </span>
      <label className="form-check">
        <input
          type="checkbox"
          checked={column.enabled}
          onChange={e => onChange({ enabled: e.target.checked })}
        />
      </label>
      <span className="mapping-original-name">{column.originalName}</span>
      <input
        className="form-input form-input--inline"
        value={column.displayName}
        onChange={e => onChange({ displayName: e.target.value })}
        placeholder={column.originalName}
        disabled={!column.enabled}
      />
    </div>
  );
}
