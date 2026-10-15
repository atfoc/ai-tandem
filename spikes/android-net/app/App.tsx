import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text } from 'react-native';

import { runChecks, type Config } from './src/checks';
import { log } from './src/net';

let started = false;

async function start(url: string | null, say: (s: string) => void) {
  if (started) return;
  if (!url || !url.startsWith('aiwbspike://run')) { log('AIWBSPIKE {"waiting":"no launch url"}'); say('waiting for a launch url'); return; }
  started = true;
  const cfg = JSON.parse(new URL(url).searchParams.get('cfg') ?? '{}') as Config;
  say('running checks against port ' + cfg.port);
  try { await runChecks(cfg); say('done'); } catch (e: any) { log('AIWBSPIKE ' + JSON.stringify({ crashed: String(e && e.stack || e) })); say('crashed'); }
}

export default function App() {
  const [status, setStatus] = useState('starting');
  useEffect(() => {
    Linking.getInitialURL().then((u) => start(u, setStatus));
    const sub = Linking.addEventListener('url', (e) => start(e.url, setStatus));
    return () => sub.remove();
  }, []);
  return (
    <ScrollView contentContainerStyle={styles.c}>
      <Text style={styles.t}>AI Whiteboard net spike</Text>
      <Text>{status}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({ c: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }, t: { fontSize: 20, marginBottom: 12 } });
