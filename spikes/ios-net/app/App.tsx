import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Native } from './modules/aiwb-net/src';
import { runChecks, runLong, type Config } from './checks';

export default function App() {
  const [status, setStatus] = useState('starting');
  useEffect(() => {
    const raw = Native.env.AIWB_CONFIG;
    if (!raw) { Native.log('NOCONFIG no AIWB_CONFIG in the environment: nothing to run'); setStatus('no config'); return; }
    const c = JSON.parse(raw) as Config;
    setStatus(`running ${c.mode}`);
    (c.mode === 'long' ? runLong(c) : runChecks(c)).then(
      () => setStatus('done'),
      (err) => { Native.log(`CRASH ${err && err.stack ? err.stack : String(err)}`); setStatus('crashed'); },
    );
  }, []);
  return (
    <View style={styles.container}>
      <Text>AI Whiteboard network spike</Text>
      <Text>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' } });
