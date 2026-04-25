import StepList from './StepList';
import AddStepMenu from './AddStepMenu';
import SetInputForm from './SetInputForm';
import ClickElementForm from './ClickElementForm';
import ScrapeForm from './ScrapeForm';
import ScrapeWholePageForm from './ScrapeWholePageForm';
import ScrapeElementsForm from './ScrapeElementsForm';
import SelectEachForm from './SelectEachForm';
import BestMatchForm from './BestMatchForm';
import GoBackForm from './GoBackForm';
import LoopConfig from './LoopConfig';
import SaveConfigForm from './SaveConfigForm';
import ElementPickerStatus from './ElementPickerStatus';
import SearchVarInput from './SearchVarInput';
import RunProgress from './RunProgress';
import ResultsView from './ResultsView';
import CreateConfigWelcome from './CreateConfigWelcome';
import CreateConfigForm from './CreateConfigForm';
import ConfigToolbar from './ConfigToolbar';
import AwaitUserActionForm from './AwaitUserActionForm';
import NetworkRecorderView from './NetworkRecorderView';
import DataMappingView from './DataMappingView';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { dispatchPickerResult } from '../utils/pickerDispatch';
import { useContentMessage } from '../utils/messageDispatcher';

export default function ConfigTab() {
  const { view, steps, editingStepId } = useConfigStore();
  const { isPickerActive, pendingPickerStepId, pendingPickerField } = useUiStore();

  useContentMessage('ELEMENT_PICKED', (payload) => {
    dispatchPickerResult(pendingPickerField, pendingPickerStepId, payload as Parameters<typeof dispatchPickerResult>[2]);
  }, [pendingPickerStepId, pendingPickerField]);

  if (isPickerActive) {
    return <ElementPickerStatus />;
  }

  const renderView = () => {
    switch (view) {
      case 'NO_CONFIG':
        return <CreateConfigWelcome />;
      case 'CREATE_CONFIG':
        return <CreateConfigForm />;
      case 'STEP_LIST':
        return <StepList />;
      case 'ADD_STEP_MENU':
        return <AddStepMenu />;
      case 'SET_INPUT_FORM':
        return <SetInputForm />;
      case 'CLICK_FORM':
        return <ClickElementForm />;
      case 'BEST_MATCH_FORM':
        return <BestMatchForm />;
      case 'GO_BACK_FORM':
        return <GoBackForm />;
      case 'SCRAPE_FORM':
        return <ScrapeForm />;
      case 'SCRAPE_WHOLE_PAGE_FORM':
        return <ScrapeWholePageForm />;
      case 'SCRAPE_ELEMENTS_FORM':
        return <ScrapeElementsForm />;
      case 'SELECT_EACH_FORM':
        return <SelectEachForm />;
      case 'CAPTURE_API_CALLS_FORM':
        return <NetworkRecorderView />;
      case 'AWAIT_USER_ACTION_FORM':
        return <AwaitUserActionForm />;
      case 'LOOP_CONFIG':
        return <LoopConfig />;
      case 'SAVE_CONFIG':
        return <SaveConfigForm />;
      case 'EDIT_STEP': {
        const editStep = steps.find(s => s.id === editingStepId);
        if (!editStep) return <StepList />;
        switch (editStep.type) {
          case 'setInput':        return <SetInputForm editingStepId={editingStepId!} />;
          case 'click':           return <ClickElementForm editingStepId={editingStepId!} />;
          case 'bestMatch':       return <BestMatchForm editingStepId={editingStepId!} />;
          case 'goBack':          return <GoBackForm editingStepId={editingStepId!} />;
          case 'scrape':
            if ((editStep.options as { mode?: string }).mode === 'wholePage')
              return <ScrapeWholePageForm editingStepId={editingStepId!} />;
            if ((editStep.options as { mode?: string }).mode === 'specificElements')
              return <ScrapeElementsForm editingStepId={editingStepId!} />;
            return <ScrapeForm editingStepId={editingStepId!} />;
          case 'selectEach':      return <SelectEachForm editingStepId={editingStepId!} />;
          case 'captureApiCalls': return <NetworkRecorderView editingStepId={editingStepId!} />;
          case 'awaitUserAction': return <AwaitUserActionForm editingStepId={editingStepId!} />;
          default:                return <StepList />;
        }
      }
      case 'SEARCH_VAR_INPUT':
        return <SearchVarInput />;
      case 'RUNNING':
        return <RunProgress />;
      case 'RESULTS':
      case 'RUN_ERROR':
        return <ResultsView />;
      case 'DATA_MAPPING':
        return <DataMappingView />;
      default:
        return <CreateConfigWelcome />;
    }
  };

  return (
    <>
      <ConfigToolbar />
      {renderView()}
    </>
  );
}
