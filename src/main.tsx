import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Authenticator } from '@aws-amplify/ui-react'
import { Amplify } from 'aws-amplify'
import '@aws-amplify/ui-react/styles.css'
import './index.css'
import App from './App.tsx'
import stubConfig from '../amplify_outputs.stub.json'

// amplify_outputs.json は npx ampx sandbox 実行後に生成される
// 未デプロイ時は stub を使用
const realConfigs = import.meta.glob('../amplify_outputs.json', { eager: true }) as Record<string, { default: typeof stubConfig }>
const config = Object.values(realConfigs)[0]?.default ?? stubConfig

Amplify.configure(config)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Authenticator>
      <App />
    </Authenticator>
  </StrictMode>,
)