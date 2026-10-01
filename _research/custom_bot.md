# 自定义机器人使用指南

自定义机器人是一种只能在当前群聊中使用的机器人。该类机器人无需经过租户管理员审核，即可在当前群聊中通过调用 webhook 地址的方式完成消息推送。本文主要介绍自定义机器人的使用方式。

## 注意事项

- 自定义机器人只能在当前群聊内使用，同一个自定义机器人无法添加到其他群聊。

- 你需要具备一定的服务端开发基础，通过请求调用自定义机器人的 webhook 地址，实现消息推送功能。

- 自定义机器人在添加至群组后即可使用，无需租户管理员审核。该特性提升了开发机器人的便携性，但出于租户数据安全考虑，也限制了自定义机器人的使用场景，自定义机器人不具有任何数据访问权限。

- 如果你希望实现机器人群管理、获取用户信息等能力，建议参考[开发卡片交互机器人](https://open.feishu.cn/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/develop-a-card-interactive-bot/introduction)，通过机器人应用实现。自定义机器人和机器人应用的能力对比，请参见[能力对比](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-overview#6994dff4)。

- 自定义机器人的频率控制和普通应用不同，为单租户单机器人 100 次/分钟，5 次/秒。**建议发送消息尽量避开诸如 10:00、17:30 等整点及半点时间**，否则可能出现因系统压力导致的 11232 限流错误，导致消息发送失败。

- 发送消息时，请求体的数据大小不能超过 20 KB。

## 功能介绍

企业存在给特定群组自动推送消息的场景，例如，推送监控报警、销售线索、运营内容等。在该类场景下，你可以在群组中添加自定义机器人，自定义机器人默认提供 webhook，通过服务端调用 webhook 地址，即可将外部系统的消息通知即时推送到群组中。自定义机器人也包含了 **自定义关键词**、**IP 白名单** 和 **签名** 三种维度的安全配置，便于控制 webhook 的调用范围。

自定义机器人消息推送示例，如下图所示：

![image.png](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/2b47757342ff761b33b92272125e5090_BFz2mPZ3QU.png?height=321&lazyload=true&maxWidth=600&width=883)

## 在群组中添加自定义机器人

### 操作步骤

1. 邀请自定义机器人进群。
    1. 进入目标群组，在群组右上角点击更多按钮，并点击 **设置**。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/0704e334f450754076202b574be3dff1_kQEGlTTPj7.png?height=1242&lazyload=true&maxWidth=600&width=1824)

2. 在右侧 **设置** 界面，点击 **群机器人**。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/8ddf497adeeb5e42d4faf91a0955649f_3PaZ3J9uwz.png?height=1240&lazyload=true&maxWidth=600&width=1810)

3. 在 **群机器人** 界面点击 **添加机器人**。

4. 在 **添加机器人** 对话框，找到并点击 **自定义机器人**。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/a9f4e16ea91fd15a272b0ba926e4c2fd_k0hrjUtKqR.png?height=1106&lazyload=true&maxWidth=600&width=1652)

5. 设置自定义机器人的头像、名称与描述，并点击 **添加**。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/71f2339063c24779f13a9710bb4a0f6e_cVn7wSbnq2.png?height=1144&lazyload=true&maxWidth=600&width=1656)

2. 获取自定义机器人的 webhook 地址，并点击 **完成**。

机器人对应的 **webhook 地址** 格式如下：

```
    https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxxxxxxxxxxx
    ```warning    
**请妥善保存好此 webhook 地址**，不要公布在 Gitlab、博客等可公开查阅的网站上，避免地址泄露后被恶意调用发送垃圾消息。

![image.png](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/39d1233fc3276c71f6fce9707abf05c9_YdZveIV7gm.png?height=1134&lazyload=true&maxWidth=600&width=1654)

后续你可以在群组名称右侧点击机器人图片，进入自定义机器人详情页，管理自定义机器人的配置信息。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/6370938ba204435cf190a93a53bd4d83_GKfn5wQXke.png?height=1478&lazyload=true&maxWidth=600&width=2284)

3. 测试调用自定义机器人的 webhook 地址，向所在群组发送消息。

1. 用任意方式向 webhook 地址发起一个 HTTP POST 请求。

你需要具备一定的服务端开发基础，通过服务端 HTTP POST 请求方式调用 webhook 地址。以 curl 指令为例，请求示例如下。你可以通过 macOS 系统的终端，或者 Windows 系统的控制台应用，执行以下命令进行测试。

- macOS

```bash
          curl -X POST -H "Content-Type: application/json" \
              -d '{"msg_type":"text","content":{"text":"request example"}}' \
              https://open.feishu.cn/open-apis/bot/v2/hook/****
          ```

- Windows(cmd)

```bash
          curl -X POST -H "Content-Type: application/json" -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"request example\"}}" https://open.feishu.cn/open-apis/bot/v2/hook/****
          ```

- Windows(PowerShell)

```bash
          curl.exe -X POST -H "Content-Type: application/json" -d '{\"msg_type\":\"text\",\"content\":{\"text\":\"requestexample\"}}' https://open.feishu.cn/open-apis/bot/v2/hook/****
          ```

示例命令说明：

- 请求方式：`POST`

- 请求头：`Content-Type: application/json`

- 请求体：`{"msg_type":"text","content":{"text":"request example"}}`

- webhook 地址：`https://open.feishu.cn/open-apis/bot/v2/hook/****` 为示例值，你在实际调用时需要替换为自定义机器人真实的 webhook 地址。

向自定义机器人发送请求时，支持发送文本、富文本、群名片以及消息卡片等多种消息类型。各类消息类型的请求说明，参见[支持发送的消息类型说明](#支持发送的消息类型说明)。

执行命令后：

- 如果请求成功，命令行将会回显以下信息。

```json
            {
                 "StatusCode": 0,               //冗余字段，用于兼容存量历史逻辑，不建议使用
                 "StatusMessage": "success",    //冗余字段，用于兼容存量历史逻辑，不建议使用
                 "code": 0,
                 "data": {},
                 "msg": "success"
            }
            ```

- 如果请求体格式错误，则会返回以下信息。

```json
            {
                    "code": 9499,
                    "msg": "Bad Request",
                    "data": {}
            }
            ```

你可以通过以下说明，检查请求体是否存在问题。

- 请求体内容格式是否与各消息类型的示例代码一致。

- 请求体大小不能超过 20 K。

2. 命令执行后，进入自定义机器人所在群组查看测试消息。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/b0c9862f7c53d6c3c7d1cdec150539c1_BImB3MewXE.png?height=244&lazyload=true&maxWidth=600&width=972)

### 后续步骤

成功添加自定义机器人后，推荐你为自定义机器人添加安全设置，以保证机器人接收请求的安全性。具体操作参见下文[为自定义机器人添加安全设置](#为自定义机器人添加安全设置)。

## 为自定义机器人添加安全设置

在群组中添加自定义机器人后，你可以为机器人添加安全设置。安全设置用于保护自定义机器人不被恶意调用，例如，当 webhook 地址因保管不当而泄露后，可能会被恶意开发者调用发送垃圾信息。通过添加安全设置，只有在符合安全设置条件的情况下，才可以成功调用机器人。

目前提供的安全设置方式如下：
- 我们强烈建议为自定义机器人添加安全设置，以提高安全性。

- 在同一个自定义机器人中，你可以设置一个或多个方法。

- 自定义关键词：只有包含至少一个关键词的消息，可以成功发送。

- IP 白名单：只有在白名单内的 IP 地址，可以成功请求 webhook 发送消息。

- 签名校验：设置签名。发送的请求必须通过签名校验，才可以成功请求 webhook 发送消息。

### 方式一：设置自定义关键词

1. 在群组名称右侧点击机器人图标，打开机器人列表，找到自定义机器人并点击进入配置页面。

你也可以在群组设置中打开机器人列表。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/6370938ba204435cf190a93a53bd4d83_GKfn5wQXke.png?height=1478&lazyload=true&maxWidth=600&width=2284)

2. 在 **安全设置** 区域，选择 **自定义关键词**。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/f239c67354d657b61822d9e52aac42ee_bvXPZpluyQ.png?height=1134&lazyload=true&maxWidth=600&width=1650)

3. 在输入框添加关键词。

- 最多可以同时设置 10 个关键词，多个关键词之间使用回车键间隔。设置后，只有包含至少一个关键词的消息才会被成功发送。

例如，关键词设置了 `应用报警` 与 `项目更新`，则请求 webhook 发送的消息内容需要至少包含 `应用报警` 或 `项目更新` 其中一个关键词。

- 设置关键词后，如果发送请求时自定义关键词校验失败，则会返回以下信息。

```json
       // 关键词校验失败
       {
            "code": 19024,
            "msg": "Key Words Not Found"
       }
       ```

4. 点击 **保存**，使生效配置。warning
**注意**：自定义关键词只对 `text`、`title` 这类文本参数值生效。例如，发送富文本消息时包含超链接标签 `{"tag":"a","text":"请查看","href":"http://www.example.com/"}`，则自定义关键词只过滤 `text` 参数值，不会过滤 `href` 参数值。

### 方式二：设置 IP 白名单

1. 在群组名称右侧点击机器人图标，打开机器人列表，找到自定义机器人并点击进入配置页面。

你也可以在群组设置中打开机器人列表。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/6370938ba204435cf190a93a53bd4d83_GKfn5wQXke.png?height=1478&lazyload=true&maxWidth=600&width=2284)

2. 在 **安全设置** 区域，选择 **IP 白名单**。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/bc3b9622a9e80ed161658dbf4bb32bcd_eUGpv9hYsu.png?height=1134&lazyload=true&maxWidth=600&width=1646)

3. 在输入框添加 IP 地址。

- 支持添加 IP 地址或地址段，最多可设置 10 个，使用回车键间隔。支持段输入，例如 `123.12.1.*` 或 `123.1.1.1/24`。设置后，机器人 webhook 地址只处理来自 IP 白名单范围内的请求。

- 设置 IP 白名单后，白名单之外的 IP 地址请求 webhook 时会校验失败，并返回以下信息。

```json
        // IP校验失败
        {
             "code": 19022,
             "msg": "Ip Not Allowed"
        }
        ```

4. 点击 **保存**，使配置生效。

### 方式三：设置签名校验

1. 在群组名称右侧点击机器人图标，打开机器人列表，找到自定义机器人并点击进入配置页面。

你也可以在群组设置中打开机器人列表。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/6370938ba204435cf190a93a53bd4d83_GKfn5wQXke.png?height=1478&lazyload=true&maxWidth=600&width=2284)

2. 在 **安全设置** 区域，选择 **签名校验**。

选择签名校验后，系统已默认提供了一个秘钥。你也可以点击 **重置**，更换秘钥。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/f18a644caf39b0ba7ad58a88758a6183_rkhZ9XrUTB.png?height=1130&lazyload=true&maxWidth=600&width=1648)

3. 点击 **复制**，复制秘钥。

4. 点击 **保存**，使配置生效。

5. 计算签名字符串。

设置签名校验后，向 webhook 发送请求需要签名校验来保障来源可信。所校验的签名需要通过时间戳与秘钥进行算法加密，即将`timestamp + "\n" + 密钥`当做签名字符串，使用 HmacSHA256 算法计算空字符串的签名结果，再进行 Base64 编码。其中，`timestamp`是指距当前时间不超过 1 小时（3600 秒）的时间戳，时间单位：s。例如，1599360473。

本文提供了以下不同语言的代码示例，用于计算获得签名字符串。

- Java 示例代码

```java
        package sign;

import javax.crypto.Mac;
        import javax.crypto.spec.SecretKeySpec;
        import java.nio.charset.StandardCharsets;
        import java.security.InvalidKeyException;
        import java.security.NoSuchAlgorithmException;
        import org.apache.commons.codec.binary.Base64;

public class SignDemo {
          public static void main(String[] args) throws NoSuchAlgorithmException, InvalidKeyException {

String secret = "demo";
            int timestamp = 1599360473;
            System.out.printf("sign: %s", GenSign(secret, timestamp));

}
          private static String GenSign(String secret, int timestamp) throws NoSuchAlgorithmException, InvalidKeyException {
            //把timestamp+"\n"+密钥当做签名字符串
            String stringToSign = timestamp + "\n" + secret;

//使用HmacSHA256算法计算签名
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(stringToSign.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] signData = mac.doFinal(new byte[]{});
            return new String(Base64.encodeBase64(signData));
          }

}
        ```

- Go 示例代码

```go
        func GenSign(secret string, timestamp int64) (string, error) {
           //timestamp + key 做sha256, 再进行base64 encode
           stringToSign := fmt.Sprintf("%v", timestamp) + "\n" + secret

var data []byte
           h := hmac.New(sha256.New, []byte(stringToSign))
           _, err := h.Write(data)
           if err != nil {
              return "", err
           }

signature := base64.StdEncoding.EncodeToString(h.Sum(nil))
           return signature, nil
        }
        ```

- Python 示例代码

```Python
        import hashlib
        import base64
        import hmac

def gen_sign(timestamp, secret):
            # 拼接timestamp和secret
            string_to_sign = '{}\n{}'.format(timestamp, secret)
            hmac_code = hmac.new(string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest()

# 对结果进行base64处理
            sign = base64.b64encode(hmac_code).decode('utf-8')

return sign
        ```

6. 获取签名字符串。

以 Java 示例代码为例，获取当前时间戳以及密钥后，运行程序获得签名字符串。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/9578d3d77db27be88a572f0e67247607_M9dq4bZ89d.png?height=1234&lazyload=true&maxWidth=600&width=2090)

获取签名字符串后，在向 webhook 发送请求时，需要加上时间戳（timestamp）和签名字符串（sign）字段信息。示例配置如下所示。

```json
    // 开启签名验证后发送文本消息
    {
            "timestamp": "1599360473",        // 时间戳。
            "sign": "xxxxxxxxxxxxxxxxxxxxx",  // 得到的签名字符串。
            "msg_type": "text",
            "content": {
                    "text": "request example"
            }
    }
    ```

如果发送请求时校验失败，你可以通过以下说明排查问题。

- 所使用的时间戳距离发送请求的时间已间隔 1 小时以上，签名已过期。

- 服务器时间与标准时间有较大偏差，导致签名过期。请注意检查、校准你的服务器时间。

- 签名不匹配导致的校验不通过，将返回以下信息。

```json
      // 签名校验失败
      {
              "code": 19021,
              "msg": "sign match fail or timestamp is not within one hour from current time"
      }
      ```

## 删除自定义机器人

在飞书群组的 **设置** 中，打开 **群机器人** 列表，找到需要删除的自定义机器人，在卡片右侧点击删除图标。

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/6e679de30f0ed674e2e5ef2f7551d5b0_bT6AripRP6.png?height=568&lazyload=true&maxWidth=600&width=1814)

## 支持发送的消息类型说明

向自定义机器人 webhook 地址发送 POST 请求时，支持推送的消息格式有 **文本**、**富文本**、**图片消息** 以及 **群名片** 等，本章节介绍各消息类型的请求格式与展示效果。

### 发送文本消息

#### 请求消息体示例

```json
{
    "msg_type": "text",
    "content": {
        "text": "新更新提醒"
    }
}
```

#### 实现效果

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/a2b95a3c351914e04ee47c6c00456065_TMMOAkNFNF.png?height=216&lazyload=true&maxWidth=600&width=916)

#### 参数说明

- 参数 `msg_type` 值为对应消息类型的映射关系，文本消息的 `msg_type` 对应值为 `text`。

- 参数 `content` 包含消息内容，文本消息的消息内容参数说明如下表所示。

| **字段** | **类型** | **是否必填** | **示例值**      | **描述** |
  | ------ | ------ | -------- | ------------ | ------ |
  | text   | string | 是        | Test content | 文本内容。  |

#### 文本消息的 @ 用法

```html
// @ 单个用户
<at user_id="ou_xxx">名字</at>
// @ 所有人
<at user_id="all">所有人</at>
```

- @ 单个用户时，`user_id`字段需填入用户的 [Open ID](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-openid) 或 [User ID](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-user-id)，且必须是有效值（仅支持 @ 自定义机器人所在群的群成员），否则取名字展示，并不产生实际的 @ 效果。
**注意事项**：在外部群聊中，仅支持使用 Open ID @ 单个用户，不支持 User ID。
- @ 所有人时，必须满足所在群开启 @ 所有人功能。

#### 文本消息 @ 用法示例

```json
{
    "msg_type": "text",
    "content": {
        "text": "<at user_id=\"ou_xxx\">Tom</at> 新更新提醒"
    }
}
```

### 发送富文本消息

富文本消息是指包含文本、超链接、图标等多种文本样式的复合文本信息。

#### 请求消息体示例

```json
{
    "msg_type": "post",
    "content": {
        "post": {
            "zh_cn": {
                "title": "项目更新通知",
                "content": [
                    [{
                        "tag": "text",
                        "text": "项目有更新: "
                    }, {
                        "tag": "a",
                        "text": "请查看",
                        "href": "http://www.example.com/"
                    }, {
                        "tag": "at",
                        "user_id": "ou_18eac8********17ad4f02e8bbbb"
                    }]
                ]
            }
        }
    }
}
```

#### 实现效果

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/4470e4b7ae2926068a51d3b3d8df22bc_6tVLxfqvEh.png?height=246&lazyload=true&maxWidth=600&width=890)

#### 参数说明

- 参数 `msg_type` 值为对应消息类型的映射关系，富文本消息的 `msg_type` 对应值为 `post`。

- 参数 `content` 包含消息内容，文本消息的消息内容参数说明如下表所示。

| **字段**  | **类型** | **是否必填** | **示例值** | **描述**                                                                                  |
  | ------- | ------ | -------- | ------- | --------------------------------------------------------------------------------------- |
  | post    | object | 是        | none    | 富文本消息。                                                                                  |
  | ∟ zh_cn | object | 是        | none    | `zh_cn`、`en_us` 分别是富文本的中、英文配置，富文本消息中至少需要包含一种语言的配置。包含的参数说明，参见下文的《`zh_cn`、`en_us` 字段说明表》。 |
  | ∟ en_us | object | 是        | none    | `zh_cn`、`en_us` 分别是富文本的中、英文配置，富文本消息中至少需要包含一种语言的配置。包含的参数说明，参见下文的《`zh_cn`、`en_us` 字段说明表》。 |

- `zh_cn`、`en_us` 字段说明表。

| **字段**  | **类型**       | **是否必填** | **示例值**                                      | **描述**                                   |
  | ------- | ------------ | -------- | -------------------------------------------- | ---------------------------------------- |
  | title   | string       | 否        | Test title                                   | 富文本消息的标题。                                |
  | content | []paragraph | 是        | [[{"tag": "text","text": "text content"}]] | 富文本消息内容。由多个段落组成，每个段落为一个`[]`节点，其中包含若干个节点。 |

#### 富文本支持的标签和参数说明

**文本标签：text**

| **字段**    | **类型**  | **是否必填** | **示例值**      | **描述**                                          |
| --------- | ------- | -------- | ------------ | ----------------------------------------------- |
| text      | string  | 是        | Text content | 文本内容。                                           |
| un_escape | boolean | 否        | false        | 表示是否 unescape 解码。默认值为 false，未用到 unescape 时可以不填。 |

**超链接标签：a**

| **字段** | **类型** | **是否必填** | **示例值**                 | **描述**                           |
| ------ | ------ | -------- | ----------------------- | -------------------------------- |
| text   | string | 是        | 测试地址                    | 超链接的文本内容。                        |
| href   | string | 是        | https://open.feishu.cn | 默认的链接地址，你需要确保链接地址的合法性，否则消息会发送失败。 |

**@ 标签：at**

| **字段**    | **类型** | **是否必填** | **示例值**                           | **描述**                                                                                                                                    |
| --------- | ------ | -------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| user_id   | string | 是        | ou_18eac85d35a26****02e8bbbb | 用户的 [Open ID](https://open.feishu.cn/document/home/user-identity-introduction/open-id) 或 [User ID](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-user-id)。<br> - @ 单个用户时，`user_id`字段必须是有效值（仅支持 @ 自定义机器人所在群的群成员）。<br> - @ 所有人时，填 `all`。 |
| user_name | string | 否        | Jian Li                           | 用户名称。                                                                                                                                     |

**图片标签：img**

| **字段**    | **类型** | **是否必填** | **示例值**                                | **描述**                                                                                                                 |
| --------- | ------ | -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| image_key | string | 是        | d640eeea-4d2f-4cb3-88d8-c96fa5**** | 图片的唯一标识。可通过 [上传图片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create) 接口获取 image_key。 |

### 发送群名片
机器人只能分享其所在群的群名片。
#### 请求消息体示例

```json
{
    "msg_type": "share_chat",
    "content":{
        "share_chat_id": "oc_f5b1a7eb27ae2****339ff"
    }
}
```

#### 实现效果

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/f214f68f1fa9a44a181e14cedf6cef73_5F5IeT5z4Y.png?height=346&lazyload=true&maxWidth=600&width=958)

#### 参数说明

| **字段**        | **类型** | **是否必填** | **示例值**                       | **描述**                                                                                                             |
| ------------- | ------ | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| share_chat_id | string | 是        | oc_f5b1a7eb27ae2****339ff | 群 ID。获取方式请参见 [群 ID 说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-id-description)。 |

### 发送图片

#### 请求消息体示例

```json
{
    "msg_type":"image",
    "content":{
        "image_key": "img_ecffc3b9-8f14-400f-a014-05eca1a4310g"
    }
}
```

#### 实现效果

![](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/2ac61380d8405b5579cb7fb7a5fb295e_JaNDWmDCgW.png?height=580&lazyload=true&maxWidth=600&width=896)

#### 参数说明

| **字段**    | **类型** | **是否必填** | **示例值**                                  | **描述**                                                                                                               |
| --------- | ------ | -------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| image_key | string | 是        | img_ecffc3b9-8f14-400f-a014-05eca1a4310g | 图片Key。可通过 [上传图片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create) 接口获取 image_key。 |

### 发送飞书卡片

飞书卡片是一种轻量的消息推送应用，可由按钮、图片等多种组件搭建而成。了解飞书卡片，参考[飞书卡片概述](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/feishu-card-overview)。了解如何使用自定义机器人发送由搭建工具搭建的卡片模板（template），参考[使用自定义机器人发送飞书卡片](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start/send-message-cards-with-custom-bot)。

#### **注意事项**

- 通过自定义机器人发送的消息卡片，只支持通过按钮、文字链方式跳转 URL，不支持点击后回调信息到服务端的[请求回调交互](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/configuring-card-interactions#5746ae32)。

- 在飞书卡片中如果需要 @ 某一用户，则需要注意：自定义机器人仅支持通过 [Open ID](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-openid) 或 [User ID](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/how-to-obtain-user-id) 实现 @ 用户，暂不支持`email`、`union_id`等其他方式。

- 发送卡片时，需要将消息体的 `content` 字符串替换为 `card` 结构体，并对整个请求消息体进行 JSON 转义。

#### **请求消息体示例**

```json
{
  "msg_type": "interactive",
  "card": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "padding": "12px 12px 12px 12px",
      "elements": [
        {
          "tag": "markdown",
          "content": "西湖，位于中国浙江省杭州市西湖区龙井路1号，杭州市区西部，汇水面积为21.22平方千米，湖面面积为6.38平方千米。",
          "text_align": "left",
          "text_size": "normal_v2",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "button",
          "text": {
            "tag": "plain_text",
            "content": "🌞更多景点介绍"
          },
          "type": "default",
          "width": "default",
          "size": "medium",
          "behaviors": [
            {
              "type": "open_url",
              "default_url": "https://baike.baidu.com/item/%E8%A5%BF%E6%B9%96/4668821",
              "pc_url": "",
              "ios_url": "",
              "android_url": ""
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "今日旅游推荐"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "blue",
      "padding": "12px 12px 12px 12px"
    }
  }
}
```

以上消息体压缩并转义的结果如下所示，你可将其放入 CURL 命令中的请求体中查看效果：

```
{\"msg_type\":\"interactive\",\"card\":{\"schema\":\"2.0\",\"config\":{\"update_multi\":true,\"style\":{\"text_size\":{\"normal_v2\":{\"default\":\"normal\",\"pc\":\"normal\",\"mobile\":\"heading\"}}}},\"body\":{\"direction\":\"vertical\",\"padding\":\"12px 12px 12px 12px\",\"elements\":[{\"tag\":\"markdown\",\"content\":\"西湖，位于中国浙江省杭州市西湖区龙井路1号，杭州市区西部，汇水面积为21.22平方千米，湖面面积为6.38平方千米。\",\"text_align\":\"left\",\"text_size\":\"normal_v2\",\"margin\":\"0px 0px 0px 0px\"},{\"tag\":\"button\",\"text\":{\"tag\":\"plain_text\",\"content\":\"🌞更多景点介绍\"},\"type\":\"default\",\"width\":\"default\",\"size\":\"medium\",\"behaviors\":[{\"type\":\"open_url\",\"default_url\":\"https://baike.baidu.com/item/%E8%A5%BF%E6%B9%96/4668821\",\"pc_url\":\"\",\"ios_url\":\"\",\"android_url\":\"\"}],\"margin\":\"0px 0px 0px 0px\"}]},\"header\":{\"title\":{\"tag\":\"plain_text\",\"content\":\"今日旅游推荐\"},\"subtitle\":{\"tag\":\"plain_text\",\"content\":\"\"},\"template\":\"blue\",\"padding\":\"12px 12px 12px 12px\"}}}
```
#### 实现效果

![image.png](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/2b47757342ff761b33b92272125e5090_BFz2mPZ3QU.png?height=321&lazyload=true&maxWidth=600&width=883)

#### 相关操作

你可以通过[飞书卡片搭建工具](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/feishu-card-cardkit/feishu-cardkit-overview)快速生成卡片，并获取数据结构进行使用，从工具中生成的数据结构对应请求消息体中的 `card` 字段。

## 常见问题

### 如何实现 @ 指定人、@ 所有人？

你可以在机器人发送的普通文本消息（text）、富文本消息（post）、消息卡片（interactive）中，使用 `at` 标签实现 @ 人效果。具体请求示意如下：

- 在普通文本消息（text）中 @ 人、@ 所有人

- `at`标签说明

```html
      // @ 指定用户
      <at user_id="ou_xxx">Name</at> //取值须使用 open_id 或 user_id 来 @ 指定人

// @ 多个指定用户
      <at user_id="ou_xxx1">Name1</at><at user_id="ou_xxx2">Name2</at> //取值须使用 open_id 或 user_id 来 @ 指定人

// @ 所有人
      <at user_id="all">所有人</at> 
      ```

- 请求体示意

```json
      {
              "msg_type": "text",
              "content": {
                      "text": "<at user_id = \"ou_f43d7bf0bxxxxxxxxxxxxxxx\">Tom</at> text content"
              }
      }
      ```

- 在富文本消息（post）中 @ 人、@所有人:

- `at`标签说明

```json
      // @ 指定用户
      {
              "tag": "at",
              "user_id": "ou_xxxxxxx", //取值须使用 open_id 或 user_id 来 @ 指定人
              "user_name": "tom"
      }

// @ 多个指定用户
      {
              "tag": "at",
              "user_id": "ou_xxxxxxx1", //取值须使用 open_id 或 user_id 来 @ 指定人
              "user_name": "tom1"
      },
      {
              "tag": "at",
              "user_id": "ou_xxxxxxx2", //取值须使用 open_id 或 user_id 来 @ 指定人
              "user_name": "tom2"
      }

// @ 所有人
      {
              "tag": "at",
              "user_id": "all", //取值使用"all"来at所有人
              "user_name": "所有人"
      } 
      ```

- 请求体示意

```json
      {
              "msg_type": "post",
              "content": {
                      "post": {
                              "zh_cn": {
                                      "title": "我是一个标题",
                                      "content": [
                                              [{
                                                              "tag": "text",
                                                              "text": "第一行 :"
                                                      },
                                                      {
                                                              "tag": "at",
                                                              "user_id": "ou_xxxxxx", //取值须使用 open_id 或 user_id 来 @ 指定人
                                                              "user_name": "tom"
                                                      }
                                              ],
                                              [{
                                                              "tag": "text",
                                                              "text": "第二行:"
                                                      },
                                                      {
                                                              "tag": "at",
                                                              "user_id": "all",
                                                              "user_name": "所有人"
                                                      }
                                              ]
                                      ]
                              }
                      }
              }
      }
      ```

- 在消息卡片 (interactive) 中@人、@所有人

- 可以使用消息卡片Markdown内容中的at人标签，标签示意如下

```html
      // at 指定用户
      <at id=ou_xxx></at> //取值须使用 open_id 或 user_id 来 @ 指定人
      // at 所有人
      <at id=all></at> 
      ```

- 请求体中的 `card` 内容示意：

```json
      {
              "msg_type": "interactive",
              "card": {
                      "elements": [{
                              "tag": "div",
                              "text": {
                                      "content": "at所有人<at id=all></at> \n at指定人<at id=ou_xxxxxx></at>", //取值须使用 open_id 或 user_id 来 @ 指定人
                                      "tag": "lark_md"
                              }
                      }]
              }
      }
      ```

### 如何获得 @ 指定人时所需要的 open_id？

自定义机器人不需要租户管理员审核即可向所在的群（包括外部群）发送消息。这一开发上的灵活性也限制自定义机器人不具有任何数据访问权限，否则会在管理员不知情的条件下，泄露租户的隐私信息.

基于这个前提，自定义机器人本身不能调用接口获取用户的 open_id，或直接通过用户的邮箱、手机号来 @ 人（恶意开发者可能用这种方式扫出群成员的头像、姓名等隐私信息）。因此，你可以开发一个机器人应用，使用以下受管控的方案获得用户的`open_id`，然后参考 [怎么实现机器人 @ 人](https://open.feishu.cn/document/ugTN1YjL4UTN24CO1UjN/uUzN1YjL1cTN24SN3UjN#acc98e1b)，在自定义机器人推送的消息中 @ 人。 

**方案一：通过邮箱或手机号反查用户的**`open_id`

1. 你需要[创建一个自建应用](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)。

2. 为应用申请权限。

通过手机号或邮箱获取用户 ID（contact:user.id:readonly），并创建应用版本，提交发版审核。

3. 在版本发布审核通过后，调用[通过手机号或邮箱获取用户 ID](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/batch_get_id)接口，即可通过用户的手机号或邮箱获取用户的`open_id`。

**方案二：解析用户发送给机器人的带 @ 人内容的消息，获取目标用户的 `open_id`**

1. 你需要[创建一个自建应用](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)。

2. 完成以下应用配置操作。

1. 为应用申请权限：获取用户发给机器人的单聊消息（im:message.p2p_msg）、获取与发送单聊、群组消息（im:message）。

2. 订阅 **消息与群组** 分类下的[接收消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)事件。

3. 为这个自建应用创建应用版本，提交发版审核。

4. 在版本审核发布后，你可以在同机器人的单聊中发送 @ 某用户的消息。解析[接收消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)事件的返回内容，其中的消息体内上报了被 @ 用户的`open_id`信息。

### 自定义机器人能响应用户消息吗？

不能，自定义机器人只能用于在群聊中自动发送通知，不能响应用户 @ 机器人的消息。如需实现机器人接收响应用户消息的功能，建议使用[应用机器人](https://open.feishu.cn/document/ukTMukTMukTM/uATM04CMxQjLwEDN)。

### 如何撤回自定义机器人发送的消息？

自定义机器人自身无法撤回自己发送的消息，必须由群聊内的群主或管理员进行撤回。撤回方式：

- 方式一：群聊的群主或管理员在飞书客户端的群聊中直接撤回消息。

![image.png](//sf3-cn.feishucdn.com/obj/open-platform-opendoc/e685a9fff074339291a64c04758866cc_dgAwKA3Pr3.png?height=836&lazyload=true&maxWidth=600&width=1812)

- 方式二：调用[撤回消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/delete)接口，以群聊的群主或管理员身份调用该接口撤回消息。

