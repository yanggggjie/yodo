# yodo

用本机已经登录的 Chrome 做事。你在 Chrome 里能做的，也可以让它做。

做不成会说明原因。

## 安装

把下面整段复制给你的 agent：

```
请安装 yodo。先执行：
npx skills add yanggggjie/yodo -g -y -a '*' -s yodo
再读取并严格执行这份说明：
https://github.com/yanggggjie/yodo/blob/main/skills/yodo/install.md
```

## 怎么用

Agent 对话里说 `yodo` + 要做的事：

```
yodo 帮我搜索一下知乎 agent 然后看看第三条帖子的内容是什么，然后给第三条点赞
```

```
yodo 打开我的 X，总结我的关注最近三条是什么
```

```
yodo 搜小红书「东京咖啡」，把前三条标题给我
```

第一次连 Chrome 时，agent 会把要点念给你（开 Chrome、勾 remote-debugging、点 Allow）。做完回「好了」即可。
