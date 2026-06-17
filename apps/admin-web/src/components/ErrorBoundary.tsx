import React from 'react';
import { Button, Result, Typography } from 'antd';
import { BugOutlined } from '@ant-design/icons';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <Result
          icon={<BugOutlined style={{ color: '#ff4d4f' }} />}
          status="error"
          title="页面出现异常"
          subTitle={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {this.state.error?.message ?? '未知错误'}
            </Typography.Text>
          }
          extra={
            <Button
              type="primary"
              onClick={() => {
                this.setState({ hasError: false, error: undefined });
                window.location.reload();
              }}
            >
              刷新页面
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
