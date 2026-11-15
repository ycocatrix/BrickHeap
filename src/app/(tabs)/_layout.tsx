import type { ComponentProps, ReactElement } from 'react';
import { Text, type ColorValue } from 'react-native';
import { Redirect, Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { common } from '@/i18n/fr/common';
import { routes } from '@/navigation/routes';
import { sessionStore } from '@/state/session';
import { useStore } from '@/state/createStore';
import { colors, font } from '@/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

function tab(title: string, icon: IoniconName) {
  return {
    title,
    tabBarAccessibilityLabel: title,
    tabBarIcon: ({ color, size }: { focused: boolean; color: ColorValue; size: number }) => (
      <Ionicons name={icon} size={size} color={typeof color === 'string' ? color : undefined} />
    ),
    // Active tab = colour AND bold label (never colour alone, §7.2).
    tabBarLabel: ({ focused, color, children }: { focused: boolean; color: ColorValue; children: string }) => (
      <Text style={{ color, fontSize: font.tiny, fontWeight: focused ? '700' : '400' }}>{children}</Text>
    ),
  };
}

// Bottom tab bar (EX_19). Scanner is the initial tab.
export default function TabsLayout(): ReactElement {
  const entered = useStore(sessionStore, (s) => s.entered);
  // Defensive: Stack.Protected already keeps this group unreachable while !entered.
  if (!entered) return <Redirect href={routes.welcome} />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={tab(common.tabs.scanner, 'scan-outline')} />
      <Tabs.Screen name="inventory" options={tab(common.tabs.inventory, 'cube-outline')} />
      <Tabs.Screen name="lists" options={tab(common.tabs.lists, 'list-outline')} />
      <Tabs.Screen name="account" options={tab(common.tabs.account, 'person-outline')} />
    </Tabs>
  );
}
