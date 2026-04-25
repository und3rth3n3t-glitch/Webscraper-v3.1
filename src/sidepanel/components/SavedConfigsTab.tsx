import ConfigList from './ConfigList';
import SearchVarInput from './SearchVarInput';
import RunProgress from './RunProgress';
import ResultsView from './ResultsView';
import DataMappingView from './DataMappingView';
import { useUiStore } from '../stores/uiStore';

export default function SavedConfigsTab() {
  const savedTabView = useUiStore(s => s.savedTabView);

  switch (savedTabView) {
    case 'SEARCH_VAR_INPUT': return <SearchVarInput />;
    case 'RUNNING':          return <RunProgress />;
    case 'RESULTS':          return <ResultsView />;
    case 'RUN_ERROR':        return <ResultsView />;
    case 'DATA_MAPPING':     return <DataMappingView />;
    default:                 return <ConfigList />;
  }
}
