import {
  Table2, BarChart3, AlignLeft, MousePointerClick, ExternalLink,
  Image, Heading, Type, ChevronDown, List, LayoutGrid,
  Navigation, FileInput, Box,
  type LucideIcon,
} from 'lucide-react';
import type { SelectorDescriptor } from '../../types/config';

const TAG_MAP: Record<string, { label: string; icon: LucideIcon }> = {
  BUTTON: { label: 'Button', icon: MousePointerClick },
  A: { label: 'Link', icon: ExternalLink },
  IMG: { label: 'Image', icon: Image },
  H1: { label: 'Heading', icon: Heading },
  H2: { label: 'Heading', icon: Heading },
  H3: { label: 'Heading', icon: Heading },
  H4: { label: 'Heading', icon: Heading },
  H5: { label: 'Heading', icon: Heading },
  H6: { label: 'Heading', icon: Heading },
  P: { label: 'Paragraph', icon: AlignLeft },
  SPAN: { label: 'Text', icon: Type },
  DIV: { label: 'Container', icon: LayoutGrid },
  SECTION: { label: 'Section', icon: LayoutGrid },
  ARTICLE: { label: 'Article', icon: AlignLeft },
  NAV: { label: 'Navigation', icon: Navigation },
  FORM: { label: 'Form', icon: FileInput },
  TEXTAREA: { label: 'Text Area', icon: Type },
  LABEL: { label: 'Label', icon: Type },
  INPUT: { label: 'Text Input', icon: Type },
  SELECT: { label: 'Dropdown', icon: ChevronDown },
  TABLE: { label: 'Data Table', icon: Table2 },
  TD: { label: 'Cell', icon: Table2 },
  TH: { label: 'Cell', icon: Table2 },
  TR: { label: 'Row', icon: Table2 },
  LI: { label: 'List Item', icon: List },
  UL: { label: 'List', icon: List },
  OL: { label: 'List', icon: List },
};

const ROLE_MAP: Record<string, { label: string; icon: LucideIcon }> = {
  button: { label: 'Button', icon: MousePointerClick },
  link: { label: 'Link', icon: ExternalLink },
  heading: { label: 'Heading', icon: Heading },
  navigation: { label: 'Navigation', icon: Navigation },
  search: { label: 'Search Box', icon: Type },
  searchbox: { label: 'Search Box', icon: Type },
};

const INPUT_TYPE_MAP: Record<string, string> = {
  checkbox: 'Checkbox',
  radio: 'Radio Button',
  email: 'Email Input',
  number: 'Number Input',
  date: 'Date Picker',
  file: 'File Upload',
  password: 'Password Input',
  url: 'URL Input',
  tel: 'Phone Input',
};

export function getFriendlyLabel(
  elementType: string | null,
  descriptor: SelectorDescriptor | null,
): { label: string; icon: LucideIcon } {
  if (elementType === 'table') return { label: 'Data Table', icon: Table2 };
  if (elementType === 'chart') return { label: 'Chart', icon: BarChart3 };
  if (elementType === 'select') return { label: 'Dropdown', icon: ChevronDown };
  if (elementType === 'list') return { label: 'List', icon: List };
  if (elementType === 'grid') return { label: 'Grid', icon: LayoutGrid };
  if (elementType === 'input') {
    const inputType = descriptor?.attributes?.type || 'text';
    const specificLabel = INPUT_TYPE_MAP[inputType];
    return { label: specificLabel || 'Text Input', icon: Type };
  }

  const role = descriptor?.attributes?.role;
  if (role && ROLE_MAP[role]) return ROLE_MAP[role];

  const tag = descriptor?.tagName?.toUpperCase();
  if (tag && TAG_MAP[tag]) return TAG_MAP[tag];

  return { label: 'Element', icon: Box };
}
