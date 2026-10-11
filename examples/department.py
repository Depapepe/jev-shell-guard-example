"""Column 1 example: call the TypeSafe API with a TYPESAFE_API_KEY."""

from typesafe_sdk import Choice, TypeSafeClient


def main():
    with TypeSafeClient(model="jev-1.13.0") as client:
        response = client.system_one(
            state={"message": "I was charged twice for my subscription."},
            questions={
                "department": Choice(
                    instructions="Which team should handle `message`?",
                    criteria={
                        "billing": "Charges, subscriptions, invoices, refunds",
                        "technical": "Software bugs, outages, integrations",
                        "other": "Requests outside those two teams",
                    },
                ),
            },
        )

    answer = response.choices["department"]
    print("team:", answer.choice)
    print("probabilities:", answer.probabilities)


if __name__ == "__main__":
    main()
