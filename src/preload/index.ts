import { contextBridge, ipcRenderer } from 'electron'

export interface WindowApi {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  onState: (cb: (state: { maximized: boolean }) => void) => () => void
}

const api = {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    onState: (cb: (state: { maximized: boolean }) => void) => {
      const listener = (_e: unknown, state: { maximized: boolean }) => cb(state)
      ipcRenderer.on('window:state', listener)
      return () => {
        ipcRenderer.off('window:state', listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type PreloadApi = typeof api
