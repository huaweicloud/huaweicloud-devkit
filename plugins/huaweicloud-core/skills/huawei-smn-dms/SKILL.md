---
name: huawei-smn-dms
description: 'Use when creating or managing SMN topics/subscriptions/messages or DMS Kafka/RabbitMQ/RocketMQ queues on Huawei Cloud. Triggers: SMN, DMS, notification, message queue, Kafka, RabbitMQ, RocketMQ, topic, subscription. NOT for: APIG (use huawei-apig), FunctionGraph triggers (use huawei-functiongraph).'
version: 1
---

# Huawei Cloud SMN / DMS

**STOP - Do not answer from general knowledge.** Follow the procedure below.

Always run `hcloud SMN <Operation> --help`, `hcloud Kafka <Operation> --help`, `hcloud RabbitMQ <Operation> --help`, or `hcloud RocketMQ <Operation> --help` before constructing commands.

## Overview

Domain expertise for SMN (Simple Message Notification) and DMS (Distributed Message Service). SMN is used for notifications and alerts. DMS covers Kafka, RabbitMQ, and RocketMQ instances.

## SMN

## Critical Warnings

| Trap                      | Why                                                           |
| ------------------------- | ------------------------------------------------------------- |
| Subscription confirmation | HTTP/HTTPS subscriptions need endpoint ping-back confirmation |
| Email subscription delay  | Email subscriptions require user to click confirmation link   |
| SMS charge per message    | Template SMS incurs per-delivery charges                      |

### Common Workflows

| Task                    | Operation                                                 |
| ----------------------- | --------------------------------------------------------- |
| List topics             | `ListTopics --cli-region=<r> --project_id=<p>`            |
| Create topic            | `CreateTopic --cli-region=<r> --project_id=<p>`           |
| Add subscription        | `AddSubscription --cli-region=<r> --project_id=<p>`       |
| List subscriptions      | `ListSubscriptions --cli-region=<r> --project_id=<p>`     |
| Create message template | `CreateMessageTemplate --cli-region=<r> --project_id=<p>` |
| Publish message         | `PublishMessage --cli-region=<r> --project_id=<p>`        |
| Delete topic            | `DeleteTopic --cli-region=<r> --project_id=<p>`           |

## DMS

> **DMS 是产品统一品牌**，涵盖 Kafka、RabbitMQ、RocketMQ 三种引擎。在 KooCLI 中，三种引擎被拆分为独立服务，**不存在 `hcloud DMS` 命令**。

### Engine → KooCLI Service Mapping

| Engine   | KooCLI Service    | Description          |
| -------- | ----------------- | -------------------- |
| Kafka    | `hcloud Kafka`    | 高吞吐分布式消息队列 |
| RabbitMQ | `hcloud RabbitMQ` | AMQP 消息代理        |
| RocketMQ | `hcloud RocketMQ` | 低延迟金融级消息队列 |

### Common Workflows

| Task                     | Service    | Operation                                                          |
| ------------------------ | ---------- | ------------------------------------------------------------------ |
| List Kafka instances     | `Kafka`    | `ListInstances --cli-region=<r> --project_id=<p>`                  |
| List RabbitMQ instances  | `RabbitMQ` | `ListInstancesDetails --cli-region=<r> --project_id=<p>`           |
| List RocketMQ instances  | `RocketMQ` | `ListInstances --cli-region=<r> --project_id=<p>`                  |
| Create Kafka instance    | `Kafka`    | `CreatePostPaidKafkaInstance --cli-region=<r> --project_id=<p>`    |
| Create RabbitMQ instance | `RabbitMQ` | `CreatePostPaidInstanceByEngine --cli-region=<r> --project_id=<p>` |
| Create RocketMQ instance | `RocketMQ` | `CreateInstanceByEngine --cli-region=<r> --project_id=<p>`         |
| List Kafka topics        | `Kafka`    | `ListInstanceTopics --cli-region=<r> --project_id=<p>`             |
| List RocketMQ topics     | `RocketMQ` | `ListRocketInstanceTopics --cli-region=<r> --project_id=<p>`       |

Discover exact parameters with `--help` before executing any command.

## Troubleshooting

| Error                       | Fix                                               |
| --------------------------- | ------------------------------------------------- |
| Subscription not confirmed  | SMN subscriptions need endpoint/user confirmation |
| DMS instance creation fails | Check VPC/subnet availability and engine version  |

## Cross-Skill References

- **CES alarms**: See `huawei-cloud-eye` for SMN-based alarm notifications
- **VPC**: See `huawei-vpc` for DMS instance networking
