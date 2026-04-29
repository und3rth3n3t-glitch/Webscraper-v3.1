import { useMemo } from 'react';
import type React from 'react';
import type { ScrapeEditorBlock, EditorBlock, BlocksAction } from '../../utils/taskTree';
import { loopAncestorsOf } from '../../utils/taskTree';
import type { ScraperConfigDto } from '../../api/types';
import BindingsEditor from '../BindingsEditor';
import { autoBindSteps, parseSetInputSteps } from '../../utils/taskEditor';

type Props = {
  block: ScrapeEditorBlock;
  blocks: EditorBlock[];
  configs: ScraperConfigDto[];
  dispatch: React.Dispatch<BlocksAction>;
};

export default function ScrapeBlockInspector({ block, blocks, configs, dispatch }: Props) {
  const loopAncestors = useMemo(
    () => loopAncestorsOf(blocks, block.id),
    [blocks, block.id],
  );

  const selectedConfig = useMemo(
    () => configs.find((c) => c.id === block.scraperConfigId) ?? null,
    [configs, block.scraperConfigId],
  );

  const setInputSteps = useMemo(
    () => (selectedConfig ? parseSetInputSteps(selectedConfig.configJson) : []),
    [selectedConfig],
  );

  const configMissing =
    !!block.scraperConfigId && !configs.find((c) => c.id === block.scraperConfigId);

  const handleConfigChange = (configId: string) => {
    const config = configs.find((c) => c.id === configId);
    const steps = config ? parseSetInputSteps(config.configJson) : [];
    const innermostLoop = loopAncestors[0] ?? null;
    const innermostLoopId = innermostLoop?.id ?? null;
    dispatch({
      type: 'UPDATE_SCRAPE',
      id: block.id,
      patch: {
        scraperConfigId: configId,
        stepBindings: autoBindSteps(steps, innermostLoopId, innermostLoop?.columns ?? []),
      },
    });
  };

  return (
    <div className="card">
      <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
        Scrape
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="scrape-config">Scraper config</label>
        <select
          id="scrape-config"
          className="form-select"
          value={block.scraperConfigId}
          onChange={(e) => handleConfigChange(e.target.value)}
        >
          <option value="">— pick a config —</option>
          {configMissing && (
            <option value={block.scraperConfigId} disabled>
              {block.scraperConfigId} (deleted)
            </option>
          )}
          {configs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="form-label" style={{ marginBottom: 'var(--spacing-sm)' }}>
        Input bindings
      </div>
      <BindingsEditor
        steps={setInputSteps}
        loopAncestors={loopAncestors}
        stepBindings={block.stepBindings}
        onChange={(bindings) =>
          dispatch({ type: 'UPDATE_SCRAPE', id: block.id, patch: { stepBindings: bindings } })
        }
      />
    </div>
  );
}
