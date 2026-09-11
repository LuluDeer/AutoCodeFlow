import React from 'react';
import { Button, Result, Typography } from 'antd';
import { BugOutlined } from '@ant-design/icons';
import { withTranslation } from 'react-i18next';
import type { WithTranslation } from 'react-i18next';
import '../i18n';

interface Props extends WithTranslation {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundaryBase extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }

  render() {
    const { t } = this.props;
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <Result
          icon={<BugOutlined style={{ color: '#ff4d4f' }} />}
          status="error"
          title={t('errorBoundary.title')}
          subTitle={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {this.state.error?.message ?? t('errorBoundary.unknownError')}
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
              {t('errorBoundary.reload')}
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}

const ErrorBoundary = withTranslation('errorBoundary')(ErrorBoundaryBase);

export { ErrorBoundary };
export default ErrorBoundary;
