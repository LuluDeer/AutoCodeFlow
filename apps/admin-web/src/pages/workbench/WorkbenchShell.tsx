/**
 * 3-pane layout shell: header, responsive grid, drawers, and status banners.
 * The rail/inspector/center nodes are passed in already-rendered so this
 * component owns only layout and visibility concerns.
 */
import { Alert, Button, Card, Drawer, Space } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined, MenuOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import PageHeader from '../../components/PageHeader';

export interface WorkbenchShellProps {
  isMobile: boolean;
  railOpen: boolean;
  inspectorOpen: boolean;
  rail: React.ReactNode;
  center: React.ReactNode;
  inspector: React.ReactNode;
  error: string | null;
  fallback: boolean;
  onOpenRail: () => void;
  onCloseRail: () => void;
  onToggleInspector: () => void;
  onCloseInspector: () => void;
}

export default function WorkbenchShell({
  isMobile, railOpen, inspectorOpen, rail, center, inspector,
  error, fallback,
  onOpenRail, onCloseRail, onToggleInspector, onCloseInspector,
}: WorkbenchShellProps) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader
        title={t('workbench.page.title')}
        description={t('workbench.page.desc')}
        extra={
          <Space wrap>
            {isMobile ? (
              <Button
                icon={<MenuOutlined aria-hidden />}
                onClick={onOpenRail}
                data-testid="workbench-rail-toggle"
              >
                {t('workbench.layout.sessions')}
              </Button>
            ) : null}
            <Button
              icon={inspectorOpen ? <MenuFoldOutlined aria-hidden /> : <MenuUnfoldOutlined aria-hidden />}
              onClick={onToggleInspector}
              data-testid="workbench-inspector-toggle"
            >
              {t('workbench.layout.inspector')}
            </Button>
          </Space>
        }
      />

      {error ? (
        <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} closable />
      ) : null}
      {fallback ? (
        <Alert
          type="warning"
          showIcon
          title={t('workbench.stream.fallback')}
          style={{ marginBottom: 12 }}
          closable
        />
      ) : null}

      <div
        data-testid="workbench-shell"
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile
            ? '1fr'
            : inspectorOpen
              ? '248px minmax(0, 1fr) 272px'
              : '248px minmax(0, 1fr)',
          gap: 12,
          alignItems: 'stretch',
          minHeight: 560,
        }}
      >
        {!isMobile ? (
          <Card size="small" styles={{ body: { height: '100%', padding: 8 } }}>{rail}</Card>
        ) : null}
        <Card size="small" styles={{ body: { height: '100%', padding: 12, display: 'flex', minHeight: 0 } }}>
          {center}
        </Card>
        {!isMobile && inspectorOpen ? (
          <Card size="small" styles={{ body: { height: '100%', padding: 8 } }}>{inspector}</Card>
        ) : null}
      </div>

      {isMobile ? (
        <Drawer
          open={railOpen}
          onClose={onCloseRail}
          title={t('workbench.layout.sessions')}
          width="86vw"
          destroyOnHidden
        >
          {rail}
        </Drawer>
      ) : null}
      {isMobile && inspectorOpen ? (
        <Drawer
          open={inspectorOpen}
          onClose={onCloseInspector}
          title={t('workbench.layout.inspector')}
          width="92vw"
          destroyOnHidden
        >
          {inspector}
        </Drawer>
      ) : null}
    </>
  );
}
