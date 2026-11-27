import { Popover, Button, Typography, Space, theme } from 'antd';
import { SettingOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

/**
 * 游标分页语义透明化：不再是开发者开关，而是可发现的说明弹层。
 * 当前能力保留（capability 仍在），默认文案清晰解释「上一页/下一页 + 无页码跳转」。
 * 需要排障/兼容旧 OFFSET 行为时，可在弹层内显式切换。
 */
export default function PagingModePopover({
  stablePaging,
  onChange,
}: {
  stablePaging: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      content={
        <Space direction="vertical" size={8} style={{ maxWidth: 320 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('execs.stablePaging.hint')}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('execs.stablePaging.aria')}
          </Text>
          <Space size={8} wrap>
            <Button
              size="small"
              type={stablePaging ? 'primary' : 'default'}
              onClick={() => { if (!stablePaging) onChange(true); }}
              disabled={stablePaging}
            >
              {t('execs.stablePaging')}
            </Button>
            <Button
              size="small"
              type={stablePaging ? 'default' : 'primary'}
              onClick={() => { if (stablePaging) onChange(false); }}
              disabled={!stablePaging}
            >
              {t('columns.reset')}
            </Button>
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('execs.stablePaging.hint')}
          </Text>
        </Space>
      }
    >
      <Button type="text" size="small" icon={<InfoCircleOutlined />}>
        {t('execs.stablePaging')}
        <SettingOutlined style={{ fontSize: 12, color: token.colorTextSecondary, marginLeft: 4 }} />
      </Button>
    </Popover>
  );
}
