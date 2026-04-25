import axios from 'axios';

export function axiosErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error ?? fallback;
  }
  return fallback;
}
