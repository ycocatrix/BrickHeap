// The only place hrefs are written (D16).
import type { Href } from 'expo-router';
export type CodePurpose = 'signup' | 'login' | 'recovery';
export const routes = {
  welcome: '/welcome' as Href,
  login: '/login' as Href,
  signup: '/signup' as Href,
  forgot: '/forgot' as Href,
  verify: (email: string, purpose: CodePurpose): Href => ({ pathname: '/verify', params: { email, purpose } }),
  newPassword: '/new-password' as Href,
  about: '/about' as Href,
  scanner: '/' as Href,
  inventory: (listId?: string | null): Href => ({ pathname: '/inventory', params: { listId: listId ?? '' } }),
  lists: '/lists' as Href,
  account: '/account' as Href,
  review: '/scan/review' as Href,
  part: (partId: string, colorId?: number | null): Href =>
    ({ pathname: '/part/[partId]', params: { partId, colorId: colorId == null ? '' : String(colorId) } }),
  exportSheet: (listId?: string | null): Href => ({ pathname: '/export', params: { listId: listId ?? '' } }),
  settings: '/settings' as Href,
  calibration: '/settings/calibration' as Href,
  profile: '/profile' as Href,
  changePassword: '/change-password' as Href,
};
