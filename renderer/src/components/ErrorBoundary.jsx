import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', gap: 12,
          color: '#e6edf3', background: '#0d1117',
        }}>
          <div style={{ fontSize: 32 }}>⚠</div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>组件渲染错误</div>
          <div style={{ color: '#8b949e', fontSize: 12, maxWidth: 480, textAlign: 'center' }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 8, padding: '6px 18px', borderRadius: 6,
              background: '#1f6feb', border: 'none', color: '#fff',
              cursor: 'pointer', fontSize: 13,
            }}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
